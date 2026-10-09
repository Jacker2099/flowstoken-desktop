package org.vetta.android.domain.direct

import kotlinx.coroutines.launch
import org.vetta.android.domain.remote.RemoteMessageEvent
import org.vetta.android.domain.remote.RemoteModelOption
import org.vetta.android.domain.remote.RemoteSessionError
import org.vetta.android.domain.remote.RemoteSessionState
import org.vetta.android.domain.remote.RemoteSessionStatus
import org.vetta.android.domain.remote.RemoteSessionSummary
import org.vetta.android.domain.remote.protocol.RemoteCrypto
import org.vetta.android.domain.remote.TranscriptAction
import org.vetta.android.domain.work.DesktopMirror
import org.vetta.android.domain.remote.TranscriptState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Constants for the desktop-free mode: sessions live on the phone and talk to the
 * account's chat API over SSE. Port of the iOS `AppModelDirect.swift` seam.
 */
object DirectChat {
    /** `projectCwd` for direct sessions — the sentinel tells them apart everywhere a
     * session travels (list rows, transcript cache, routing of sends and deletes). */
    const val PROJECT_KEY = "vetta-direct"

    /** `SessionCache` namespace for direct sessions and their transcripts. */
    const val STORE_KEY = "direct"

    /** Direct session ids carry this prefix so they stay recognizable in transcripts. */
    const val ID_PREFIX = "direct-"

    /** The routing model the account picks; maps to the server's Bestoo-Auto entry. */
    const val DEFAULT_MODEL = "Bestoo-Auto"

    /** How many turns of history a prompt carries back to the API. */
    const val HISTORY_LIMIT = 40
}

/** A phone-local session served by the account API, not a paired desktop. */
val RemoteSessionSummary.isDirect: Boolean
    get() = projectCwd == DirectChat.PROJECT_KEY

/** What the UI shows of the signed-in account; tokens never leave [DirectAuth]. */
data class DirectAccount(val name: String, val group: String)

internal fun DesktopMirror.isDirectId(sessionId: String): Boolean = sessionId.startsWith(DirectChat.ID_PREFIX)

val DesktopMirror.directSignedIn: Boolean
    get() = state.value.direct != null

// MARK: Sign in / out

/** The URL the browser must open for the PKCE login; the callback comes back to [finishDirectLogin]. */
fun DesktopMirror.beginDirectLogin(): String = directAuth.beginLogin().url

/**
 * Consumes the `flowstoken://auth/callback` deep link. False when it was not the app's
 * callback or the exchange failed; a user cancellation stays silent.
 */
suspend fun DesktopMirror.finishDirectLogin(url: String): Boolean {
    try {
        directAuth.finishLogin(url)
    } catch (error: Throwable) {
        if (error !is DirectAuthError.Cancelled) reportError(error)
        return false
    }
    applyDirectAccount()
    scope.launch { loadDirectModels() }
    scope.launch {
        try {
            directAuth.refreshAccount()
            applyDirectAccount()
        } catch (_: Throwable) {
        }
    }
    return true
}

suspend fun DesktopMirror.signOutDirect() {
    directTasks.values.forEach { it.cancel() }
    directTasks.clear()
    directAuth.signOut()
    mutate {
        it.copy(
            direct = null,
            directModels = emptyList(),
            sessions = it.sessions.filterNot { session -> session.isDirect },
            transcripts = it.transcripts.filterKeys { id -> !isDirectId(id) },
        )
    }
    platform.cache.clearDesktop(DirectChat.STORE_KEY)
}

internal fun DesktopMirror.applyDirectAccount() {
    mutate { state ->
        state.copy(
            direct =
                directAuth.state?.let { DirectAccount(name = it.accountName, group = it.group) },
        )
    }
}

/** What the stored session was restored as at launch. */
internal fun DesktopMirror.loadDirectState() {
    val stored = directAuth.state ?: return
    mutate { it.copy(direct = DirectAccount(name = stored.accountName, group = stored.group)) }
    directSessions = platform.cache.loadSessions(DirectChat.STORE_KEY).filter { it.isDirect }
}

/** Direct sessions sit ahead of the desktop list, most recent first. */
internal fun DesktopMirror.mergeSessions(remote: List<RemoteSessionSummary>): List<RemoteSessionSummary> =
    directSessions + remote

// MARK: Sessions

/**
 * Creates a direct session and sends its first prompt. Unlike [DesktopMirror.startSession]
 * the id is final: nothing here waits on a desktop.
 */
fun DesktopMirror.startDirectChat(text: String, modelKey: String? = null): String? {
    val trimmed = text.trim()
    if (trimmed.isEmpty() || directAuth.state == null) return null
    val id = DirectChat.ID_PREFIX + RemoteCrypto.toBase64Url(RemoteCrypto.randomBytes(12))
    val model = modelKey ?: DirectChat.DEFAULT_MODEL
    val now = platform.now()
    val summary =
        RemoteSessionSummary(
            id = id,
            projectCwd = DirectChat.PROJECT_KEY,
            projectName = "FlowsToken",
            title = trimmed.take(60),
            preview = trimmed,
            updatedAt = now,
            status = RemoteSessionStatus.Running,
            live = true,
        )
    directSessions = listOf(summary) + directSessions
    mutate { it.copy(sessions = listOf(summary) + it.sessions) }
    persistDirectSessions()
    var transcript =
        reducer.reduce(
            TranscriptState.Empty,
            TranscriptAction.History(emptyList(), RemoteSessionState(RemoteSessionStatus.Running, model = model, modelKey = model)),
        )
    transcript = reducer.reduce(transcript, TranscriptAction.LocalUser(trimmed, now))
    mutate { it.copy(transcripts = it.transcripts + (id to transcript)) }
    streamDirect(id)
    return id
}

/** Follow-up prompt inside a direct session; `sendPrompt` routes here. */
fun DesktopMirror.sendDirectPrompt(sessionId: String, text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty() || state.value.session(sessionId)?.isDirect != true) return
    val now = platform.now()
    dispatch(sessionId, TranscriptAction.LocalUser(trimmed, now))
    patchDirectSession(sessionId) { it.copy(preview = trimmed, updatedAt = now) }
    streamDirect(sessionId)
}

/** Runs one completion and feeds the transcript. The history rebuilds from it each turn. */
private fun DesktopMirror.streamDirect(sessionId: String) {
    directTasks[sessionId]?.cancel()
    val model = state.value.transcript(sessionId).sessionState.modelKey ?: DirectChat.DEFAULT_MODEL
    dispatch(sessionId, TranscriptAction.State(RemoteSessionState(RemoteSessionStatus.Running, model = model, modelKey = model)))
    patchDirectSession(sessionId) { it.copy(status = RemoteSessionStatus.Running) }
    directTasks[sessionId] =
        scope.launch {
            try {
                val key = directAuth.chatKey()
                val history = directHistory(sessionId)
                var reply = ""
                directChatClient.stream(key = key, model = model, messages = history).collect { event ->
                    when (event) {
                        is DirectChatEvent.Delta -> {
                            reply += event.text
                            dispatch(sessionId, TranscriptAction.Message(RemoteMessageEvent.AssistantDelta(event.text)))
                        }
                        is DirectChatEvent.Reasoning ->
                            if (state.value.preferences.liveThinking) {
                                dispatch(sessionId, TranscriptAction.Message(RemoteMessageEvent.ThinkingDelta(event.text)))
                            }
                        DirectChatEvent.Done -> dispatch(sessionId, TranscriptAction.Message(RemoteMessageEvent.TurnEnd(platform.now())))
                    }
                }
                dispatch(sessionId, TranscriptAction.State(RemoteSessionState(RemoteSessionStatus.Idle, model = model, modelKey = model)))
                patchDirectSession(sessionId) {
                    it.copy(
                        status = RemoteSessionStatus.Idle,
                        updatedAt = platform.now(),
                        preview = if (reply.isNotEmpty()) reply.lineSequence().firstOrNull() ?: reply else it.preview,
                    )
                }
                if (state.value.preferences.haptics && active) platform.onTurnEnd()
            } catch (error: kotlinx.coroutines.CancellationException) {
                dispatch(sessionId, TranscriptAction.State(RemoteSessionState(RemoteSessionStatus.Idle, model = model, modelKey = model)))
                patchDirectSession(sessionId) { it.copy(status = RemoteSessionStatus.Idle) }
            } catch (error: DirectAuthError.SignedOut) {
                dispatch(
                    sessionId,
                    TranscriptAction.State(
                        RemoteSessionState(RemoteSessionStatus.Error, error = RemoteSessionError("signedOut", "signedOut")),
                    ),
                )
                patchDirectSession(sessionId) { it.copy(status = RemoteSessionStatus.Error) }
                signOutDirect()
            } catch (error: Throwable) {
                dispatch(
                    sessionId,
                    TranscriptAction.State(
                        RemoteSessionState(
                            RemoteSessionStatus.Error,
                            error = RemoteSessionError("chat", error::class.simpleName ?: "error"),
                        ),
                    ),
                )
                patchDirectSession(sessionId) { it.copy(status = RemoteSessionStatus.Error) }
                reportError(error)
            } finally {
                directTasks.remove(sessionId)
            }
        }
}

/** The conversation the API sees: transcript users and finished assistant turns. */
private fun DesktopMirror.directHistory(sessionId: String): List<DirectChatMessage> {
    val messages = mutableListOf<DirectChatMessage>()
    for (item in state.value.transcript(sessionId).items) {
        when (item) {
            is org.vetta.android.domain.remote.TranscriptItem.User -> messages += DirectChatMessage("user", item.text)
            is org.vetta.android.domain.remote.TranscriptItem.Assistant ->
                if (!item.turn.streaming && item.turn.error == null && item.turn.text.isNotEmpty()) {
                    messages += DirectChatMessage("assistant", item.turn.text)
                }
            else -> continue
        }
    }
    return if (messages.size > DirectChat.HISTORY_LIMIT) messages.takeLast(DirectChat.HISTORY_LIMIT) else messages
}

/** Switches a direct session's model; it applies to the next completion. */
fun DesktopMirror.configureDirect(sessionId: String, modelKey: String) {
    if (state.value.session(sessionId)?.isDirect != true) return
    val current = state.value.transcript(sessionId).sessionState
    dispatch(sessionId, TranscriptAction.State(RemoteSessionState(current.status, model = modelKey, modelKey = modelKey)))
}

/** The account's model catalog for direct chats and the direct new-session picker. */
suspend fun DesktopMirror.loadDirectModels() {
    if (directAuth.state == null) return
    try {
        val key = directAuth.chatKey()
        val (status, body) =
            (platform.directFetch ?: DirectAuth.ktorFetch)(
                DirectRequest(
                    method = "GET",
                    url = DirectEndpoints.MODELS,
                    headers = mapOf("Authorization" to "Bearer $key"),
                ),
            )
        if (status !in 200..299) throw DirectAuthError.Server(status)
        val root = Json.parseToJsonElement(body).jsonObject
        val options =
            (root["data"] as? JsonArray).orEmpty().mapNotNull { entry ->
                val id = entry.jsonObject["id"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                RemoteModelOption(key = id, name = id, provider = "FlowsToken", thinkingLevels = emptyList(), supportsImage = false)
            }
        if (options.isNotEmpty()) mutate { it.copy(directModels = options) }
    } catch (error: Throwable) {
        if (error is kotlinx.coroutines.CancellationException) throw error
        // The catalog failing never blocks chat; the default model still works.
        platform.logger.info("direct model list failed", mapOf("error" to error::class.simpleName))
    }
}

// MARK: Local upkeep

internal fun DesktopMirror.patchDirectSession(sessionId: String, patch: (RemoteSessionSummary) -> RemoteSessionSummary) {
    val index = directSessions.indexOfFirst { it.id == sessionId }
    if (index < 0) return
    directSessions = directSessions.toMutableList().also { it[index] = patch(it[index]) }
    patchSession(sessionId, patch)
    persistDirectSessions()
}

internal fun DesktopMirror.persistDirectSessions() {
    platform.cache.saveSessions(DirectChat.STORE_KEY, directSessions)
}

/** Local rename/pin/delete share the summary list; nothing reaches a desktop. */
internal fun DesktopMirror.applyDirectLocal(sessionId: String, patch: (RemoteSessionSummary) -> RemoteSessionSummary): Boolean {
    if (state.value.session(sessionId)?.isDirect != true) return false
    patchDirectSession(sessionId, patch)
    return true
}

internal fun DesktopMirror.deleteDirectSession(sessionId: String) {
    directTasks[sessionId]?.cancel()
    directTasks.remove(sessionId)
    directSessions = directSessions.filterNot { it.id == sessionId }
    mutate {
        it.copy(
            sessions = it.sessions.filterNot { session -> session.id == sessionId },
            transcripts = it.transcripts - sessionId,
        )
    }
    platform.cache.saveTranscript(DirectChat.STORE_KEY, sessionId, emptyList())
    persistDirectSessions()
}

/** The transcript cache namespace for `sessionId`: direct sessions share one store. */
internal fun DesktopMirror.transcriptStoreKey(sessionId: String): String? =
    if (isDirectId(sessionId)) DirectChat.STORE_KEY else desktopKey
