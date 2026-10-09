import Foundation
import Testing
@testable import VettaKit

/// Canned SSE lines for `DirectChatClient`; also captures the request it was built with.
nonisolated final class DirectLineFake: @unchecked Sendable {
	var status = 200
	var lines: [String] = []
	private(set) var lastRequest: URLRequest?

	var source: DirectLineSource {
		{ request in
			self.lastRequest = request
			let lines = self.lines
			return (self.status, AsyncThrowingStream { continuation in
				for line in lines { continuation.yield(line) }
				continuation.finish()
			})
		}
	}
}

@Suite struct DirectChatParserTests {
	@Test func deltasArriveInOrderAcrossEvents() throws {
		var parser = DirectChatParser()
		var events: [DirectChatEvent] = []
		for line in [
			"data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}",
			"",
			"data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}",
			"",
			"data: [DONE]",
			"",
		] {
			events += try parser.feed(line)
		}
		events += try parser.finish()
		#expect(events == [.delta("你好"), .delta("，世界"), .done])
	}

	@Test func reasoningContentMapsToThinkingAndErrorsThrow() throws {
		var parser = DirectChatParser()
		// An event's payload flushes on its blank-line boundary.
		#expect(try parser.feed("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"想想\"}}]}") == [])
		#expect(try parser.feed("") == [.reasoning("想想")])
		_ = try parser.feed("data: {\"error\":{\"message\":\"quota exhausted\"}}")
		#expect(throws: DirectChatError.message("quota exhausted")) {
			_ = try parser.feed("")
		}
	}

	@Test func malformedPayloadsAreSkippedAndEofStillClosesTheTurn() throws {
		var parser = DirectChatParser()
		#expect(try parser.feed("data: not json at all") == [])
		#expect(try parser.feed(": keep-alive") == [])
		#expect(try parser.finish() == [.done])
	}
}

@Suite(.serialized) struct DirectChatClientTests {
	@Test func streamsAssistantTextWithTheSkKeyAndTurnEnd() async throws {
		let fake = DirectLineFake()
		fake.lines = [
			"data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}",
			"",
			"data: {\"choices\":[{\"delta\":{\"content\":\"!\"}}]}",
			"",
			"data: [DONE]",
			"",
		]
		let client = DirectChatClient(lines: fake.source)
		var events: [DirectChatEvent] = []
		for try await event in client.stream(key: "sk-x", model: "Bestoo-Auto", messages: [DirectChatMessage(role: "user", content: "hey")]) {
			events.append(event)
		}
		#expect(events == [.delta("Hi"), .delta("!"), .done])
		let request = try #require(fake.lastRequest)
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer sk-x")
		#expect(request.url?.path == "/v1/chat/completions")
		let body = try #require(request.httpBody.map { String(decoding: $0, as: UTF8.self) })
		#expect(body.contains("\"model\":\"Bestoo-Auto\""))
		#expect(body.contains("\"stream\":true"))
		// JSONSerialization orders object keys freely.
		#expect(body.contains("\"role\":\"user\"") && body.contains("\"content\":\"hey\""))
	}

	@Test func nonSuccessStatusFailsTheStream() async {
		let fake = DirectLineFake()
		fake.status = 429
		fake.lines = ["{\"error\":{\"message\":\"rate limited\"}}"]
		let client = DirectChatClient(lines: fake.source)
		await #expect(throws: DirectChatError.server(429)) {
			for try await _ in client.stream(key: "sk-x", model: "m", messages: []) {}
		}
	}
}
