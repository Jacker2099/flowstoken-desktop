package org.vetta.android.domain.direct

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest

private fun chatWith(vararg lines: String, seen: MutableList<DirectRequest>? = null): DirectChatClient =
    DirectChatClient(
        lines = { request ->
            seen?.add(request)
            flowOf(*lines)
        },
    )

private fun delta(text: String) = """data: {"choices":[{"delta":{"content":"$text"}}]}"""

private fun reasoning(text: String) = """data: {"choices":[{"delta":{"reasoning_content":"$text"}}]}"""

class DirectChatTest {
    @Test
    fun streamsAssistantDeltasUntilDone() =
        runTest {
            val requests = mutableListOf<DirectRequest>()
            val client = chatWith(delta("Hel"), "", delta("lo"), "", "data: [DONE]", "", seen = requests)
            val events = client.stream("sk-key", "Bestoo-Auto", listOf(DirectChatMessage("user", "hey"))).toList()
            assertEquals(listOf(DirectChatEvent.Delta("Hel"), DirectChatEvent.Delta("lo"), DirectChatEvent.Done), events)

            val request = requests.single()
            assertEquals(DirectEndpoints.CHAT_COMPLETIONS, request.url)
            assertEquals("Bearer sk-key", request.headers["Authorization"])
            assertTrue(request.body!!.contains("\"model\":\"Bestoo-Auto\""))
            assertTrue(request.body!!.contains("\"stream\":true"))
            assertTrue(request.body!!.contains("\"role\":\"user\"") && request.body!!.contains("\"content\":\"hey\""))
        }

    @Test
    fun streamsReasoningAlongsideTheAnswer() =
        runTest {
            val client = chatWith(reasoning("thinking"), "", delta("answer"), "", "data: [DONE]")
            val events = client.stream("sk-k", "m", emptyList()).toList()
            assertEquals(
                listOf(DirectChatEvent.Reasoning("thinking"), DirectChatEvent.Delta("answer"), DirectChatEvent.Done),
                events,
            )
        }

    @Test
    fun skipsMalformedEventsRatherThanKillingTheStream() =
        runTest {
            val client = chatWith("data: {not json", "", delta("ok"), "", "data: [DONE]")
            val events = client.stream("sk-k", "m", emptyList()).toList()
            assertEquals(listOf(DirectChatEvent.Delta("ok"), DirectChatEvent.Done), events)
        }

    @Test
    fun stitchesSplitDataLinesIntoOneEvent() =
        runTest {
            // SSE allows several data: lines per event; the JSON may be split across them.
            val client = chatWith("""data: {"choices":[""", """data: {"delta":{"content":"hi"}}]}""", "", "data: [DONE]")
            val events = client.stream("sk-k", "m", emptyList()).toList()
            assertEquals(listOf(DirectChatEvent.Delta("hi"), DirectChatEvent.Done), events)
        }

    @Test
    fun providerErrorsSurfaceAsChatErrors() =
        runTest {
            val client = chatWith("""data: {"error":{"message":"quota exceeded"}}""")
            assertFailsWith<DirectChatError.Provider> {
                client.stream("sk-k", "m", emptyList()).toList()
            }
        }

    @Test
    fun httpErrorsSurfaceAsStatusErrors() =
        runTest {
            val failing: Flow<String> = kotlinx.coroutines.flow.flow { throw DirectChatError.Http(429) }
            val client = DirectChatClient(lines = { failing })
            val error = assertFailsWith<DirectChatError.Http> {
                client.stream("sk-k", "m", emptyList()).toList()
            }
            assertEquals(429, error.status)
        }
}
