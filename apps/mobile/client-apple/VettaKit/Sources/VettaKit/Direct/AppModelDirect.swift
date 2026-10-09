import Foundation
import os

private let log = Logger(subsystem: "com.flowstoken.mobile", category: "direct")

/// Constants for the desktop-free mode: sessions live on the phone and talk to the
/// account's chat API over SSE.
public enum DirectChat {
	/// `projectCwd` for direct sessions — the sentinel tells them apart everywhere a
	/// session travels (list rows, transcript cache, routing of sends and deletes).
	public static let projectKey = "vetta-direct"
	/// `SessionCache` namespace for direct sessions and their transcripts.
	public static let storeKey = "direct"
	/// Direct session ids carry this prefix so they stay recognizable in transcripts.
	public static let idPrefix = "direct-"
	/// The routing model the account picks; maps to the server's Bestoo-Auto entry.
	public static let defaultModel = "Bestoo-Auto"
	/// How many turns of history a prompt carries back to the API.
	static let historyLimit = 40
}

/// What the UI shows of the signed-in account; tokens never leave `DirectAuth`.
public struct DirectAccount: Equatable, Sendable {
	public var name: String
	public var group: String

	public init(name: String, group: String) {
		self.name = name
		self.group = group
	}
}

extension RemoteSessionSummary {
	/// A phone-local session served by the account API, not a paired desktop.
	public var isDirect: Bool { projectCwd == DirectChat.projectKey }
}

extension AppModel {
	static func isDirectId(_ sessionId: String) -> Bool { sessionId.hasPrefix(DirectChat.idPrefix) }

	public var directSignedIn: Bool { direct != nil }

	// MARK: Sign in / out

	/// The URL the system browser must open for the PKCE login; the callback comes
	/// back to `finishDirectLogin`.
	public func beginDirectLogin() -> URL {
		directAuth.beginLogin().url
	}

	/// Consumes the `flowstoken://auth/callback` deep link. False when it was not the
	/// app's callback or the exchange failed; a user cancellation stays silent.
	@discardableResult
	public func finishDirectLogin(_ url: URL) async -> Bool {
		do {
			try await directAuth.finishLogin(url)
		} catch {
			if error as? DirectAuthError != .cancelled { reportError(error) }
			return false
		}
		direct = directAuth.state.map { DirectAccount(name: $0.displayName.isEmpty ? $0.username : $0.displayName, group: $0.group) }
		Task { await loadDirectModels() }
		Task { try? await directAuth.refreshAccount(); direct = directAuth.state.map { DirectAccount(name: $0.displayName.isEmpty ? $0.username : $0.displayName, group: $0.group) } }
		return true
	}

	public func signOutDirect() async {
		for (_, task) in directTasks { task.cancel() }
		directTasks = [:]
		await directAuth.signOut()
		direct = nil
		directModels = []
		sessions = sessions.filter { !$0.isDirect }
		transcripts = transcripts.filter { !$0.key.hasPrefix(DirectChat.idPrefix) }
		platform.cache.clearDesktop(DirectChat.storeKey)
	}

	/// What the stored session was restored as at launch.
	func loadDirectState() {
		guard let state = directAuth.state else { return }
		direct = DirectAccount(name: state.displayName.isEmpty ? state.username : state.displayName, group: state.group)
		directSessions = platform.cache.loadSessions(DirectChat.storeKey).filter { $0.isDirect }
	}

	/// Direct sessions sit ahead of the desktop list, most recent first.
	func mergeSessions(remote: [RemoteSessionSummary]) -> [RemoteSessionSummary] {
		directSessions + remote
	}

	// MARK: Sessions

	/// Creates a direct session and sends its first prompt. Unlike `startSession` the
	/// id is final: nothing here waits on a desktop.
	@discardableResult
	public func startDirectChat(_ text: String, modelKey: String? = nil) -> String? {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty, direct != nil else { return nil }
		let id = DirectChat.idPrefix + UUID().uuidString
		let model = modelKey ?? DirectChat.defaultModel
		let now = WallClock.nowMs()
		let summary = RemoteSessionSummary(
			id: id,
			projectCwd: DirectChat.projectKey,
			projectName: "FlowsToken",
			title: String(trimmed.prefix(60)),
			preview: trimmed,
			updatedAt: now,
			status: .running,
			live: true
		)
		directSessions = [summary] + directSessions
		sessions = [summary] + sessions
		persistDirectSessions()
		var transcript = TranscriptReducer.reduce(.empty, .history(
			entries: [],
			state: RemoteSessionState(status: .running, model: model, modelKey: model)
		))
		transcript = TranscriptReducer.reduce(transcript, .localUser(text: trimmed, at: now))
		transcripts[id] = transcript
		streamDirect(id)
		return id
	}

	/// Follow-up prompt inside a direct session; `sendPrompt` routes here.
	public func sendDirectPrompt(_ sessionId: String, _ text: String) {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty, session(sessionId)?.isDirect == true else { return }
		let now = WallClock.nowMs()
		dispatch(sessionId, .localUser(text: trimmed, at: now))
		patchDirectSession(sessionId) {
			$0.preview = trimmed
			$0.updatedAt = now
		}
		streamDirect(sessionId)
	}

	/// Runs one completion and feeds the transcript. `history` holds the exchange for
	/// the next turn; it rebuilds from the transcript on cold opens.
	private func streamDirect(_ sessionId: String) {
		directTasks[sessionId]?.cancel()
		let model = transcript(sessionId).sessionState.modelKey ?? DirectChat.defaultModel
		dispatch(sessionId, .state(RemoteSessionState(status: .running, model: model, modelKey: model)))
		patchDirectSession(sessionId) { $0.status = .running }
		awaitingOutput.insert(sessionId)
		directTasks[sessionId] = Task { [weak self] in
			guard let self else { return }
			do {
				let key = try await self.directAuth.chatKey()
				// The prompt is the transcript's last entry already; history carries it.
				let history = self.directHistory(sessionId)
				var reply = ""
				for try await event in self.directChatClient.stream(key: key, model: model, messages: history) {
					if Task.isCancelled { break }
					switch event {
					case let .delta(text):
						reply += text
						self.outputStarted(sessionId)
						self.dispatch(sessionId, .message(.assistantDelta(text)))
					case let .reasoning(text):
						self.outputStarted(sessionId)
						if self.preferences.liveThinking { self.dispatch(sessionId, .message(.thinkingDelta(text))) }
					case .done:
						self.dispatch(sessionId, .message(.turnEnd(at: WallClock.nowMs())))
					}
				}
				if Task.isCancelled { return }
				self.dispatch(sessionId, .state(RemoteSessionState(status: .idle, model: model, modelKey: model)))
				self.patchDirectSession(sessionId) {
					$0.status = .idle
					$0.updatedAt = WallClock.nowMs()
					if !reply.isEmpty { $0.preview = reply.components(separatedBy: .newlines).first ?? reply }
				}
				if self.preferences.haptics, self.active { self.platform.onTurnEnd?() }
			} catch is CancellationError {
				self.dispatch(sessionId, .state(RemoteSessionState(status: .idle, model: model, modelKey: model)))
				self.patchDirectSession(sessionId) { $0.status = .idle }
			} catch let error as DirectAuthError where error == .signedOut {
				self.dispatch(sessionId, .state(RemoteSessionState(status: .error, error: RemoteSessionError(code: "signedOut", message: "signedOut"))))
				self.patchDirectSession(sessionId) { $0.status = .error }
				await self.signOutDirect()
			} catch {
				self.dispatch(sessionId, .state(RemoteSessionState(status: .error, error: RemoteSessionError(code: "chat", message: String(describing: type(of: error))))))
				self.patchDirectSession(sessionId) { $0.status = .error }
				self.reportError(error)
			}
			self.directTasks[sessionId] = nil
			self.awaitingOutput.remove(sessionId)
		}
	}

	/// The conversation the API sees: transcript users and finished assistant turns,
	/// newest `historyLimit` entries. The streaming turn is never echoed back.
	private func directHistory(_ sessionId: String) -> [DirectChatMessage] {
		var messages: [DirectChatMessage] = []
		for item in transcript(sessionId).items {
			switch item {
			case let .user(_, text, _, _):
				messages.append(DirectChatMessage(role: "user", content: text))
			case let .assistant(turn) where !turn.streaming && turn.error == nil && !turn.text.isEmpty:
				messages.append(DirectChatMessage(role: "assistant", content: turn.text))
			default: continue
			}
		}
		if messages.count > DirectChat.historyLimit { messages = Array(messages.suffix(DirectChat.historyLimit)) }
		return messages
	}

	/// Switches a direct session's model; it applies to the next completion.
	public func configureDirect(_ sessionId: String, modelKey: String) {
		guard session(sessionId)?.isDirect == true else { return }
		dispatch(sessionId, .state(RemoteSessionState(status: transcript(sessionId).sessionState.status, model: modelKey, modelKey: modelKey)))
	}

	/// The account's model catalog for direct chats and the direct new-session picker.
	public func loadDirectModels() async {
		guard directAuth.state != nil else { return }
		do {
			let key = try await directAuth.chatKey()
			var request = URLRequest(url: DirectEndpoints.models)
			request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
			let fetch = platform.directFetch ?? DirectAuth.urlFetch
			let (data, response) = try await fetch(request)
			guard (200 ..< 300).contains(response.statusCode) else { throw DirectAuthError.server(response.statusCode) }
			let value = try JSONValue.parse(data)
			let options = (value["data"]?.arrayValue ?? []).compactMap { entry -> RemoteModelOption? in
				guard let id = entry["id"]?.stringValue, !id.isEmpty else { return nil }
				return RemoteModelOption(key: id, name: id, provider: "FlowsToken", thinkingLevels: [], supportsImage: false)
			}
			if !options.isEmpty { directModels = options }
		} catch {
			// The catalog failing never blocks chat; the default model still works.
			log.info("direct model list failed: \(String(describing: type(of: error)), privacy: .public)")
		}
	}

	// MARK: Local upkeep

	func patchDirectSession(_ sessionId: String, _ patch: (inout RemoteSessionSummary) -> Void) {
		guard let index = directSessions.firstIndex(where: { $0.id == sessionId }) else { return }
		patch(&directSessions[index])
		patchSession(sessionId, patch)
		persistDirectSessions()
	}

	func persistDirectSessions() {
		platform.cache.saveSessions(DirectChat.storeKey, directSessions)
	}

	/// Local rename/pin/delete/abort share the summary list; nothing reaches a desktop.
	func applyDirectLocal(_ sessionId: String, _ patch: (inout RemoteSessionSummary) -> Void) -> Bool {
		guard session(sessionId)?.isDirect == true else { return false }
		patchDirectSession(sessionId, patch)
		return true
	}

	func deleteDirectSession(_ sessionId: String) {
		directTasks[sessionId]?.cancel()
		directTasks[sessionId] = nil
		directSessions.removeAll { $0.id == sessionId }
		sessions.removeAll { $0.id == sessionId }
		transcripts[sessionId] = nil
		platform.cache.saveTranscript(DirectChat.storeKey, sessionId, [])
		persistDirectSessions()
	}

	/// The transcript cache namespace for `sessionId`: direct sessions share one store.
	func transcriptStoreKey(_ sessionId: String) -> String? {
		Self.isDirectId(sessionId) ? DirectChat.storeKey : desktopKey
	}
}
