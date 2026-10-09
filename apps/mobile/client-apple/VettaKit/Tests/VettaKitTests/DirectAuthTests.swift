import Foundation
import Testing
@testable import VettaKit

/// Records requests and answers them from a script, keyed by the last path component.
/// Tests run serialized on the main actor, so the unsynchronized store is safe.
nonisolated final class DirectHTTPFake: @unchecked Sendable {
	struct Call {
		var method: String
		var url: URL
		var headers: [String: String]
		var body: String
	}

	private(set) var calls: [Call] = []
	private var responses: [String: [(Int, String)]] = [:]

	/// `match` is a substring of the request path; the next matching call pops the first reply.
	func respond(_ match: String, status: Int = 200, json: String) {
		responses[match, default: []].append((status, json))
	}

	var fetch: DirectFetch {
		{ request in
			let body = request.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
			self.calls.append(Call(
				method: request.httpMethod ?? "GET",
				url: request.url!,
				headers: request.allHTTPHeaderFields ?? [:],
				body: body
			))
			let path = request.url!.path
			for (match, queue) in self.responses where !queue.isEmpty && path.contains(match) {
				var queue = queue
				let (status, json) = queue.removeFirst()
				self.responses[match] = queue
				return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
			}
			return (Data("{\"success\":true,\"data\":{}}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
	}

	func calls(matching match: String) -> [Call] {
		calls.filter { $0.url.path.contains(match) }
	}
}

@Suite(.serialized) struct DirectAuthTests {
	private func makeAuth() -> (DirectAuth, DirectHTTPFake, MemoryKeyValueStore) {
		let secrets = MemoryKeyValueStore()
		let http = DirectHTTPFake()
		let auth = DirectAuth(secrets: secrets, fetch: http.fetch)
		return (auth, http, secrets)
	}

	@Test func loginOpensTheAuthorizePageWithTheMobileClientAndPKCE() {
		let (auth, _, _) = makeAuth()
		let url = auth.beginLogin().url
		let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
		#expect(components.scheme == "https")
		#expect(components.host == "www.flowstoken.com")
		#expect(components.path == "/auth/desktop")
		let query = Dictionary(uniqueKeysWithValues: components.queryItems!.map { ($0.name, $0.value ?? "") })
		#expect(query["client_id"] == "flowstoken-mobile")
		#expect(query["redirect_uri"] == "flowstoken://auth/callback")
		#expect(query["code_challenge_method"] == "S256")
		#expect(query["state"]?.count == 43)
		#expect(query["code_challenge"]?.count == 43)
		#expect(query["code_challenge"]?.range(of: "[^A-Za-z0-9_-]", options: .regularExpression) == nil)
	}

	@Test func finishingLoginExchangesTheCodeAndPersistsTheSession() async throws {
		let (auth, http, secrets) = makeAuth()
		let attempt = auth.beginLogin()
		http.respond("exchange", json: """
			{"success":true,"data":{"access_token":"at-1","token_type":"Bearer","access_expires_at":4102444800,
			"refresh_token":"rt-1","session":{"sid":"sid-1"},
			"user":{"id":7,"username":"ada","display_name":"Ada","group":"smart"}}}
			""")

		let callback = URL(string: "flowstoken://auth/callback?code=code-1&state=\(attempt.state)")!
		try await auth.finishLogin(callback)

		let exchange = try #require(http.calls(matching: "exchange").first)
		#expect(exchange.method == "POST")
		#expect(exchange.body.contains("\"client_id\":\"flowstoken-mobile\""))
		#expect(exchange.body.contains("\"code_verifier\":\"\(attempt.verifier)\""))
		#expect(auth.state?.accessToken == "at-1")
		#expect(auth.state?.refreshToken == "rt-1")
		#expect(auth.state?.sessionSid == "sid-1")
		#expect(auth.state?.username == "ada")
		// The credential survives relaunch through the secrets store.
		let restored = DirectAuth(secrets: secrets, fetch: http.fetch)
		#expect(restored.state?.accessToken == "at-1")
		#expect(restored.state?.refreshToken == "rt-1")
	}

	@Test func foreignCallbacksAndMismatchedStateAreRejected() async {
		let (auth, _, _) = makeAuth()
		_ = auth.beginLogin()
		for bad in [
			"flowstoken://pair?code=x",
			"https://evil.example/auth/callback?code=x",
			"flowstoken://auth/callback?code=x&state=wrong-state",
			"flowstoken://auth/other?code=x",
		] {
			await #expect(throws: DirectAuthError.badCallback) { try await auth.finishLogin(URL(string: bad)!) }
		}
		#expect(auth.state == nil)
	}

	@Test func userDenyingConsentOnThePageCancelsTheAttempt() async {
		let (auth, _, _) = makeAuth()
		let attempt = auth.beginLogin()
		await #expect(throws: DirectAuthError.cancelled) {
			try await auth.finishLogin(URL(string: "flowstoken://auth/callback?error=access_denied&state=\(attempt.state)")!)
		}
		#expect(!auth.signingIn)
	}

	@Test func expiredAccessTokenRefreshesThroughTheMobileHeaderRoute() async throws {
		let (_, http, secrets) = makeAuth()
		secrets.set(DirectAuth.stateKey, """
			{"accessToken":"at-old","refreshToken":"rt-old","accessExpiresAt":1,"sessionSid":"sid-1",
			"userId":7,"username":"ada","displayName":"Ada","group":"smart"}
			""")
		let reloaded = DirectAuth(secrets: secrets, fetch: http.fetch)
		http.respond("mobile/refresh", json: """
			{"success":true,"data":{"access_token":"at-new","token_type":"Bearer","access_expires_at":4102444800,
			"refresh_token":"rt-new","session":{"sid":"sid-1"},"user":{"id":7,"username":"ada","display_name":"Ada","group":"smart"}}}
			""")

		let token = try await reloaded.accessToken()

		#expect(token == "at-new")
		let refresh = try #require(http.calls(matching: "mobile/refresh").first)
		#expect(refresh.headers["X-Auth-Refresh"] == "rt-old")
		#expect(refresh.headers["X-Auth-Session"] == "sid-1")
		#expect(reloaded.state?.refreshToken == "rt-new")
		#expect(DirectAuth(secrets: secrets, fetch: http.fetch).state?.refreshToken == "rt-new")
	}

	@Test func chatKeyCreatesTheManagedTokenInTheUsersGroupAndReusesIt() async throws {
		let (_, http, secrets) = makeAuth()
		secrets.set(DirectAuth.stateKey, """
			{"accessToken":"at-1","refreshToken":"rt-1","accessExpiresAt":4102444800,"sessionSid":"sid-1",
			"userId":7,"username":"ada","displayName":"Ada","group":"smart"}
			""")
		let reloaded = DirectAuth(secrets: secrets, fetch: http.fetch)
		// `.path` drops the trailing slash, so the list/create calls match "api/token".
		http.respond("api/token", json: """
			{"success":true,"data":{"items":[],"total":0}}
			""") // list: nothing yet
		http.respond("api/token", json: """
			{"success":true,"data":{"id":42}}
			""") // create
		http.respond("/key", json: #"{"success":true,"data":{"key":"abc123"}}"#)

		let key = try await reloaded.chatKey()

		#expect(key == "sk-abc123")
		let create = http.calls(matching: "api/token").first { $0.method == "POST" && $0.body.contains("\"name\":\"FlowsToken-Mobile\"") }
		#expect(create?.body.contains("\"group\":\"smart\"") == true)
		#expect(http.calls(matching: "/key").first?.method == "POST")
		// Stored in the session: a second call makes no requests.
		let calls = http.calls.count
		#expect(try await reloaded.chatKey() == "sk-abc123")
		#expect(http.calls.count == calls)
		#expect(DirectAuth(secrets: secrets, fetch: http.fetch).state?.chatKey == "sk-abc123")
	}

	@Test func signOutPostsTheHeaderCredentialsAndClearsLocalSecrets() async throws {
		let (_, http, secrets) = makeAuth()
		secrets.set(DirectAuth.stateKey, """
			{"accessToken":"at-1","refreshToken":"rt-1","accessExpiresAt":4102444800,"sessionSid":"sid-1",
			"userId":7,"username":"ada","displayName":"Ada","group":"smart","chatKey":"sk-x"}
			""")
		let reloaded = DirectAuth(secrets: secrets, fetch: http.fetch)

		await reloaded.signOut()

		let logout = try #require(http.calls(matching: "mobile/logout").first)
		#expect(logout.headers["Authorization"] == "Bearer at-1")
		#expect(logout.headers["X-Auth-Refresh"] == "rt-1")
		#expect(logout.headers["X-Auth-Session"] == "sid-1")
		#expect(reloaded.state == nil)
		#expect(secrets.get(DirectAuth.stateKey) == nil)
	}
}
