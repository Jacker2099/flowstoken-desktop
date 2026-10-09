import Foundation
import Testing
@testable import VettaKit

/// A signed-in account fixture: credentials in secrets, HTTP and SSE seams faked.
private func directPlatform(
	http: DirectHTTPFake? = nil,
	lines: DirectLineFake? = nil,
	createTransport: @escaping TransportFactory = { _, _ in DeadTransport() }
) -> AppPlatform {
	var platform = AppPlatform.memory(createTransport: createTransport)
	platform.secrets.set(DirectAuth.stateKey, """
		{"accessToken":"at-1","refreshToken":"rt-1","accessExpiresAt":4102444800,"sessionSid":"sid-1",
		"userId":7,"username":"ada","displayName":"Ada","group":"smart","chatKey":"sk-test"}
		""")
	platform.directFetch = http?.fetch
	platform.directLines = lines?.source
	return platform
}

private func assistantText(_ model: AppModel, _ sessionId: String) -> String {
	model.transcript(sessionId).items.compactMap { item -> String? in
		if case let .assistant(turn) = item { return turn.text }
		return nil
	}.joined()
}

@Suite(.serialized) struct DirectSessionTests {
	@Test func signedInUserChatsWithNoDesktopConnected() async throws {
		let lines = DirectLineFake()
		lines.lines = [
			"data: {\"choices\":[{\"delta\":{\"content\":\"直接\"}}]}",
			"",
			"data: {\"choices\":[{\"delta\":{\"content\":\"回答\"}}]}",
			"",
			"data: [DONE]",
			"",
		]
		let model = AppModel(platform: directPlatform(lines: lines))
		model.start()

		#expect(model.direct?.name == "Ada")
		#expect(model.direct?.group == "smart")
		#expect(!model.paired && !model.online)

		let id = try #require(model.startDirectChat("你好"))
		#expect(id.hasPrefix("direct-"))
		let summary = try #require(model.session(id))
		#expect(summary.isDirect && summary.status == .running)
		#expect(await eventually { model.session(id)?.status == .idle })

		#expect(assistantText(model, id) == "直接回答")
		// The request carried the chat key and the session's default model.
		let request = try #require(lines.lastRequest)
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer sk-test")
		#expect(request.httpBody.map { String(decoding: $0, as: UTF8.self) }?.contains("\"model\":\"Bestoo-Auto\"") == true)
	}

	@Test func followUpPromptsCarryTheConversationAndSurviveRelaunch() async throws {
		let lines = DirectLineFake()
		lines.lines = ["data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}", "", "data: [DONE]", ""]
		let platform = directPlatform(lines: lines)
		let model = AppModel(platform: platform)
		model.start()
		let id = try #require(model.startDirectChat("第一句"))
		#expect(await eventually { model.session(id)?.status == .idle })

		lines.lines = ["data: {\"choices\":[{\"delta\":{\"content\":\"second\"}}]}", "", "data: [DONE]", ""]
		#expect(await model.sendPrompt(id, "第二句") == id)
		#expect(await eventually { assistantText(model, id).contains("second") })
		// The API saw both turns: prior exchange plus the new prompt.
		let body = try #require(lines.lastRequest?.httpBody.map { String(decoding: $0, as: UTF8.self) })
		#expect(body.contains("第一句") && body.contains("first") && body.contains("第二句"))

		// Relaunch: the session and its transcript come back from the cache (saves
		// are debounced, so wait for the write before building the new model).
		#expect(await eventually { platform.cache.loadTranscript(DirectChat.storeKey, id) != nil })
		let relaunched = AppModel(platform: platform)
		relaunched.start()
		#expect(relaunched.session(id)?.isDirect == true)
		await relaunched.openSession(id)
		#expect(assistantText(relaunched, id).contains("first"))
		#expect(assistantText(relaunched, id).contains("second"))
	}

	@Test func directSessionsCoexistWithAPairedDesktop() async throws {
		let desktop = scriptedDirectDesktop()
		let lines = DirectLineFake()
		lines.lines = ["data: {\"choices\":[{\"delta\":{\"content\":\"local\"}}]}", "", "data: [DONE]", ""]
		var platform = directPlatform(lines: lines, createTransport: desktop.createTransport)
		platform.configureManager = { $0.lanBudgetMs = 30 }
		let model = AppModel(platform: platform)
		model.start()
		defer { model.unpair() }
		let invite = PairingURI.build(RemotePairingInvite(pairingId: "pair-1234567890abcdef", mobileSecret: "secret-1234567890abcdef", desktopIdentityKey: desktop.identityKey, desktopName: "MacBook Pro", lanEndpoints: ["192.168.1.20:43117"], relayBaseUrl: nil))
		#expect(await model.pairWithCode(invite))
		#expect(await eventually { model.sessions.contains { $0.id == "s1" } })

		let directId = try #require(model.startDirectChat("offline ok"))
		#expect(await eventually { assistantText(model, directId).contains("local") })
		#expect(model.sessions.map(\.id).contains("s1"), "desktop sessions stay")
		#expect(model.sessions.first?.isDirect == true, "direct sessions lead the list")

		// The desktop list arriving again must not drop the direct session.
		await model.refreshSessions()
		#expect(model.sessions.contains { $0.id == directId })
		#expect(model.sessions.contains { $0.id == "s1" })
	}

	@Test func deleteRenameAndPinStayLocal() async throws {
		let model = AppModel(platform: directPlatform(lines: DirectLineFake()))
		model.start()
		let id = try #require(model.startDirectChat("temporary"))
		#expect(await model.rename(id, to: "改名"))
		#expect(model.session(id)?.title == "改名")
		#expect(await model.setPinned(id, true))
		#expect(model.session(id)?.pinned == true)
		#expect(await model.deleteSession(id))
		#expect(model.session(id) == nil)
	}

	@Test func signingOutRemovesDirectSessionsAndCredentials() async throws {
		let http = DirectHTTPFake()
		let lines = DirectLineFake()
		lines.lines = ["data: [DONE]", ""]
		let platform = directPlatform(http: http, lines: lines)
		let model = AppModel(platform: platform)
		model.start()
		let id = try #require(model.startDirectChat("bye"))
		#expect(await eventually { model.session(id)?.status == .idle })

		await model.signOutDirect()

		#expect(model.direct == nil)
		#expect(model.session(id) == nil)
		#expect(platform.secrets.get(DirectAuth.stateKey) == nil)
		#expect(model.transcript(id).items.isEmpty)
		// A relaunch comes up signed out with no direct sessions.
		let relaunched = AppModel(platform: platform)
		relaunched.start()
		#expect(relaunched.direct == nil)
		#expect(!relaunched.sessions.contains { $0.isDirect })
	}

	private func scriptedDirectDesktop() -> FakeDesktop {
		let desktop = FakeDesktop()
		desktop.onHello = { _ in .approve }
		desktop.onRequest = { connection, request in
			if request.method == .sessionList {
				try? connection.respond(requestId: request.requestId, success: true, payload: ["sessions": [
					["id": "s1", "projectCwd": "/conv", "projectName": "对话", "title": "桌面会话", "updatedAt": 1_000, "status": "completed", "live": false],
				]])
			}
		}
		return desktop
	}
}
