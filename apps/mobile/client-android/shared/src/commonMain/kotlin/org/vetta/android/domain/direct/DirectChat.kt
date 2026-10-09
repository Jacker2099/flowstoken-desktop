package org.vetta.android.domain.direct

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.preparePost
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.vetta.android.core.net.platformHttpClientEngine

/** One turn's message to the chat API. */
@Serializable
data class DirectChatMessage(val role: String, val content: String)

/** What the SSE stream yields to the transcript. */
sealed interface DirectChatEvent {
    data class Delta(val text: String) : DirectChatEvent

    /** Reasoning text some providers stream alongside the answer. */
    data class Reasoning(val text: String) : DirectChatEvent

    data object Done : DirectChatEvent
}

/** The stream could not be read as chat; carries no request bodies or keys. */
sealed class DirectChatError : Exception() {
    data class Http(val status: Int) : DirectChatError()

    data class Provider(override val message: String) : DirectChatError()
}

/** Raw SSE lines for one request; the platform layer supplies the socket. */
typealias DirectLineSource = suspend (DirectRequest) -> Flow<String>

/**
 * OpenAI-compatible `chat/completions` over SSE, mapped onto the same transcript
 * events a desktop session produces: assistant deltas, reasoning deltas, `[DONE]`.
 * Malformed single events are skipped rather than killing the stream.
 */
class DirectChatClient(
    private val lines: DirectLineSource = ktorLines,
) {
    /** One completion: the account's `sk-` key picks the group, so routing stays server-side. */
    fun stream(key: String, model: String, messages: List<DirectChatMessage>): Flow<DirectChatEvent> = flow {
        val request =
            DirectRequest(
                method = "POST",
                url = DirectEndpoints.CHAT_COMPLETIONS,
                headers =
                    mapOf(
                        "Authorization" to "Bearer $key",
                        "Accept" to "text/event-stream",
                        "Content-Type" to "application/json",
                    ),
                body =
                    buildJsonObject {
                        put("model", model)
                        put("stream", true)
                        put(
                            "messages",
                            kotlinx.serialization.json.JsonArray(
                                messages.map { message ->
                                    buildJsonObject {
                                        put("role", message.role)
                                        put("content", message.content)
                                    }
                                },
                            ),
                        )
                    }.toString(),
            )
        val source = lines(request)
        var data = StringBuilder()
        var done = false
        source.collect { line ->
            if (line.isEmpty()) {
                // SSE event boundary: one `data:` record per event is the common shape,
                // but a split payload is stitched before parsing.
                done = flush(data, this)
                data = StringBuilder()
                if (done) return@collect
            } else if (line.startsWith("data:")) {
                if (data.isNotEmpty()) data.append('\n')
                data.append(line.removePrefix("data:").trimStart())
            }
            // Comments and `event:`/`id:`/`retry:` fields carry nothing the chat needs.
        }
        if (!done && data.isNotEmpty()) flush(data, this)
    }

    private suspend fun flush(data: StringBuilder, emit: kotlinx.coroutines.flow.FlowCollector<DirectChatEvent>): Boolean {
        val payload = data.toString().trim()
        if (payload.isEmpty()) return false
        if (payload == "[DONE]") {
            emit.emit(DirectChatEvent.Done)
            return true
        }
        val obj =
            try {
                Json.parseToJsonElement(payload) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return false
        // A provider error mid-stream ends it the same way the HTTP layer would have.
        (obj["error"] as? JsonObject)?.let { error ->
            throw DirectChatError.Provider(error["message"]?.jsonPrimitive?.contentOrNull ?: "provider error")
        }
        if (obj["error"] is JsonPrimitive) {
            throw DirectChatError.Provider(obj["error"]!!.jsonPrimitive.contentOrNull ?: "provider error")
        }
        val choices = obj["choices"]?.jsonArray ?: return false
        for (choice in choices) {
            val delta = (choice as? JsonObject)?.get("delta") as? JsonObject ?: continue
            delta["reasoning_content"]?.jsonPrimitive?.contentOrNull
                ?.takeIf { it.isNotEmpty() }
                ?.let { emit.emit(DirectChatEvent.Reasoning(it)) }
            delta["content"]?.jsonPrimitive?.contentOrNull
                ?.takeIf { it.isNotEmpty() }
                ?.let { emit.emit(DirectChatEvent.Delta(it)) }
        }
        return false
    }

    companion object {
        private val client by lazy { HttpClient(platformHttpClientEngine()) { expectSuccess = false } }

        /** ktor+OkHttp SSE: status first, then the body as lines until the socket closes. */
        val ktorLines: DirectLineSource = { request ->
            val call =
                client.preparePost(request.url) {
                    request.headers.forEach { (name, value) -> header(name, value) }
                    contentType(ContentType.Application.Json)
                    request.body?.let { setBody(it) }
                }
            flow {
                call.execute { response ->
                    if (!response.status.value.let { it in 200..299 }) {
                        throw DirectChatError.Http(response.status.value)
                    }
                    val channel = response.bodyAsChannel()
                    while (!channel.isClosedForRead) {
                        channel.readUTF8Line()?.let { emit(it.trimEnd('\r')) }
                    }
                }
            }
        }
    }
}
