import Foundation

/// One step of a streamed chat completion, already mapped onto the message kinds the
/// transcript reducer understands.
public enum DirectChatEvent: Equatable, Sendable {
	case delta(String)
	case reasoning(String)
	/// The stream ended normally (`[DONE]` or EOF); carries nothing because the
	/// transcript stamps turn end itself.
	case done
}

public enum DirectChatError: Error, Equatable {
	case server(Int)
	/// The API's own error payload (`{"error":{"message":…}}`).
	case message(String)
	case malformed
}

/// A chat-completions message; `role` is `user` or `assistant`.
public struct DirectChatMessage: Equatable, Codable, Sendable {
	public var role: String
	public var content: String

	public init(role: String, content: String) {
		self.role = role
		self.content = content
	}
}

/// Turns a request into a stream of raw SSE lines, injected for tests.
public typealias DirectLineSource = @Sendable (URLRequest) async throws -> (Int, AsyncThrowingStream<String, Error>)

/// Stateful SSE reader for one response body. `feed` takes one line at a time and
/// returns the events it completes; multi-line `data:` payloads join before decoding.
public struct DirectChatParser {
	private var dataLines: [String] = []
	private var sawDone = false

	public init() {}

	public mutating func feed(_ line: String) throws -> [DirectChatEvent] {
		// Blank line: the event boundary. Comment lines (`:…`) are keep-alives.
		if line.isEmpty {
			let payload = dataLines.joined(separator: "\n")
			dataLines.removeAll()
			return try decode(payload)
		}
		if line.hasPrefix(":") { return [] }
		guard line.hasPrefix("data:") else { return [] }
		var value = line.dropFirst(5)
		if value.hasPrefix(" ") { value = value.dropFirst() }
		dataLines.append(String(value))
		return []
	}

	/// EOF; any buffered data decodes, then the stream is done.
	public mutating func finish() throws -> [DirectChatEvent] {
		let payload = dataLines.joined(separator: "\n")
		dataLines.removeAll()
		var events = try decode(payload)
		if !sawDone {
			sawDone = true
			events.append(.done)
		}
		return events
	}

	private mutating func decode(_ payload: String) throws -> [DirectChatEvent] {
		guard !payload.isEmpty else { return [] }
		if payload == "[DONE]" {
			sawDone = true
			return [.done]
		}
		// Unparseable data (keep-alive junk, partial proxies) skips, it never kills the chat.
		guard let value = try? JSONValue.parse(payload) else { return [] }
		if let message = value["error"]?["message"]?.stringValue ?? value["error"]?.stringValue {
			throw DirectChatError.message(message)
		}
		var events: [DirectChatEvent] = []
		for choice in value["choices"]?.arrayValue ?? [] {
			let delta = choice["delta"]
			if let text = delta?["reasoning_content"]?.stringValue, !text.isEmpty { events.append(.reasoning(text)) }
			if let text = delta?["content"]?.stringValue, !text.isEmpty { events.append(.delta(text)) }
			// A non-streamed shape (`message.content`) answers like one delta.
			if let text = choice["message"]?["content"]?.stringValue, !text.isEmpty { events.append(.delta(text)) }
		}
		return events
	}
}

/// Streams OpenAI-compatible chat completions from the FlowsToken gateway with the
/// managed `sk-` key. Transport is a line source so tests replay canned SSE.
public struct DirectChatClient: Sendable {
	public var lines: DirectLineSource

	public init(lines: @escaping DirectLineSource = DirectChatClient.urlLines) {
		self.lines = lines
	}

	public static func urlLines(_ request: URLRequest) async throws -> (Int, AsyncThrowingStream<String, Error>) {
		let (bytes, response) = try await URLSession.shared.bytes(for: request)
		guard let http = response as? HTTPURLResponse else { throw DirectChatError.malformed }
		let stream = AsyncThrowingStream<String, Error> { continuation in
			let task = Task {
				do {
					for try await line in bytes.lines { continuation.yield(line) }
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in task.cancel() }
		}
		return (http.statusCode, stream)
	}

	public func request(key: String, model: String, messages: [DirectChatMessage]) throws -> URLRequest {
		var request = URLRequest(url: DirectEndpoints.chatCompletions)
		request.httpMethod = "POST"
		request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
		request.httpBody = try JSONSerialization.data(withJSONObject: [
			"model": model,
			"stream": true,
			"messages": messages.map { ["role": $0.role, "content": $0.content] },
		])
		return request
	}

	/// Events of one completion. A non-2xx status is read as a plain-text/JSON error.
	public func stream(key: String, model: String, messages: [DirectChatMessage]) -> AsyncThrowingStream<DirectChatEvent, Error> {
		AsyncThrowingStream { continuation in
			let task = Task {
				do {
					let (status, lines) = try await self.lines(self.request(key: key, model: model, messages: messages))
					guard (200 ..< 300).contains(status) else { throw DirectChatError.server(status) }
					var parser = DirectChatParser()
					for try await line in lines {
						for event in try parser.feed(line) { continuation.yield(event) }
						if Task.isCancelled { break }
					}
					for event in try parser.finish() { continuation.yield(event) }
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in task.cancel() }
		}
	}
}
