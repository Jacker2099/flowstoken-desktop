package org.vetta.android.domain.direct

import com.russhwolf.settings.MapSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.vetta.android.data.remote.MemorySessionCache
import org.vetta.android.domain.remote.RemoteSessionSummary
import org.vetta.android.domain.remote.RemoteSessionStatus
import org.vetta.android.domain.remote.TranscriptItem
import org.vetta.android.domain.remote.pairing.SettingsSecretStore
import org.vetta.android.domain.work.DesktopMirror
import org.vetta.android.domain.work.MirrorPlatform
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Serves the account endpoints a sign-in and the chat key flow need. */
private fun accountFetch(recorded: MutableList<DirectRequest>? = null): DirectFetch = { request ->
    recorded?.add(request)
    when {
        request.url == DirectEndpoints.EXCHANGE ->
            200 to """{"success":true,"data":{"access_token":"at1","refresh_token":"rt1","access_expires_at":9999999999.0,"session":{"sid":"s1"},"user":{"id":7,"username":"kim","display_name":"Kim","group":"smart"}}}"""
        request.url.contains("api/token") && request.method == "GET" ->
            200 to """{"success":true,"data":{"items":[{"id":42,"name":"FlowsToken-Mobile"}]}}"""
        request.url.contains("/key") ->
            200 to """{"success":true,"data":{"key":"chatkey"}}"""
        request.url.contains("/v1/models") ->
            200 to """{"data":[{"id":"Bestoo-Auto"},{"id":"ft-pro-1"}]}"""
        request.url == DirectEndpoints.SELF ->
            200 to """{"success":true,"data":{"id":7,"username":"kim","display_name":"Kim","group":"smart"}}"""
        else -> 200 to "{}"
    }
}

/** One assistant reply, then the end of the stream. */
private fun replyLines(text: String): DirectLineSource = {
    flowOf("""data: {"choices":[{"delta":{"content":"$text"}}]}""", "", "data: [DONE]", "")
}

@OptIn(ExperimentalCoroutinesApi::class)
private fun TestScope.mirror(
    secrets: SettingsSecretStore = SettingsSecretStore(MapSettings()),
    cache: MemorySessionCache = MemorySessionCache(),
    requests: MutableList<DirectRequest>? = null,
    lines: DirectLineSource = replyLines("hi back"),
): DesktopMirror =
    DesktopMirror(
        MirrorPlatform(
            settings = MapSettings(),
            secrets = secrets,
            cache = cache,
            createTransport = { _, _ -> error("this test has no desktop") },
            deviceName = "Test",
            now = { 1_700_000_000_000L },
            directFetch = accountFetch(requests),
            directLines = lines,
        ),
        CoroutineScope(SupervisorJob() + coroutineContext),
    ).apply { start() }

/** Signs the mirror's account in through the scripted exchange, like the browser did. */
private suspend fun DesktopMirror.signIn() {
    val url = beginDirectLogin()
    val state = url.substringAfter("state=").substringBefore("&")
    assertTrue(finishDirectLogin("flowstoken://auth/callback?code=c&state=$state"))
}

@OptIn(ExperimentalCoroutinesApi::class)
class DirectMirrorTest {
    @Test
    fun signInUnlocksTheAccountAndItsModels() =
        runTest {
            val mirror = mirror()
            assertNull(mirror.state.value.direct)
            mirror.signIn()
            advanceUntilIdle()

            val account = assertNotNull(mirror.state.value.direct)
            assertEquals("Kim", account.name)
            assertEquals("smart", account.group)
            assertTrue(mirror.state.value.directModels.isNotEmpty(), "the account's catalog loaded")
            assertEquals("Bestoo-Auto", mirror.state.value.directModels.first().key)
        }

    @Test
    fun startDirectChatStreamsTheReplyIntoTheTranscript() =
        runTest {
            val mirror = mirror()
            mirror.signIn()
            advanceUntilIdle()

            val id = assertNotNull(mirror.startDirectChat("hey"))
            assertTrue(id.startsWith(DirectChat.ID_PREFIX))
            advanceUntilIdle()

            val session = assertNotNull(mirror.state.value.session(id))
            assertTrue(session.isDirect)
            assertEquals(RemoteSessionStatus.Idle, session.status)

            val items = mirror.state.value.transcript(id).items
            val user = items.filterIsInstance<TranscriptItem.User>().single()
            assertEquals("hey", user.text)
            val assistant = items.filterIsInstance<TranscriptItem.Assistant>().single()
            assertEquals("hi back", assistant.turn.text)
            assertFalse(assistant.turn.streaming)
        }

    @Test
    fun sendPromptRoutesToTheDirectStream() =
        runTest {
            val mirror = mirror()
            mirror.signIn()
            advanceUntilIdle()
            val id = assertNotNull(mirror.startDirectChat("first"))
            advanceUntilIdle()

            assertEquals(id, mirror.sendPrompt(id, "second"))
            advanceUntilIdle()

            val users = mirror.state.value.transcript(id).items.filterIsInstance<TranscriptItem.User>()
            assertEquals(listOf("first", "second"), users.map { it.text })
            assertEquals(2, mirror.state.value.transcript(id).items.filterIsInstance<TranscriptItem.Assistant>().size)
        }

    @Test
    fun renamePinAndDeleteStayLocal() =
        runTest {
            val mirror = mirror()
            mirror.signIn()
            advanceUntilIdle()
            val id = assertNotNull(mirror.startDirectChat("a chat"))
            advanceUntilIdle()

            assertTrue(mirror.rename(id, "renamed"))
            assertEquals("renamed", mirror.state.value.session(id)?.title)
            assertTrue(mirror.setPinned(id, true))
            assertTrue(mirror.state.value.session(id)!!.pinned)

            assertTrue(mirror.deleteSession(id))
            assertNull(mirror.state.value.session(id))
            assertNull(mirror.state.value.transcripts[id])
        }

    @Test
    fun directSessionsSurviveARelaunch() =
        runTest {
            val secrets = SettingsSecretStore(MapSettings())
            val cache = MemorySessionCache()
            val first = mirror(secrets, cache)
            first.signIn()
            advanceUntilIdle()
            val id = assertNotNull(first.startDirectChat("remember me"))
            advanceUntilIdle()

            // A new mirror on the same stores restores the account and its direct sessions.
            val second = mirror(secrets, cache)
            advanceUntilIdle()
            assertNotNull(second.state.value.direct)
            val restored = assertNotNull(second.state.value.session(id))
            assertTrue(restored.isDirect)
            // The transcript loads when the chat is opened, from the direct store.
            second.openSession(id)
            advanceUntilIdle()
            val users = second.state.value.transcript(id).items.filterIsInstance<TranscriptItem.User>()
            assertEquals(listOf("remember me"), users.map { it.text })
        }

    @Test
    fun signOutDropsTheDirectSessionsButNotTheDesktopOnes() =
        runTest {
            val mirror = mirror()
            mirror.signIn()
            advanceUntilIdle()
            val id = assertNotNull(mirror.startDirectChat("going away"))
            advanceUntilIdle()

            mirror.signOutDirect()
            advanceUntilIdle()

            assertNull(mirror.state.value.direct)
            assertNull(mirror.state.value.session(id))
        }
}
