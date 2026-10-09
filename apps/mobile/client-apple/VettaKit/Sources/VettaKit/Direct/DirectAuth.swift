import CryptoKit
import Foundation
import os

private let directLog = Logger(subsystem: "com.flowstoken.mobile", category: "direct")

/// One HTTPS request/response round trip, injected so tests never touch the network.
public typealias DirectFetch = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

/// Endpoints and constants for the account-side API; the values are the FlowsToken
/// server's, shared by the whole direct-chat feature.
public enum DirectEndpoints {
	public static let base = URL(string: "https://www.flowstoken.com")!
	public static let clientId = "flowstoken-mobile"
	public static let redirectURI = "flowstoken://auth/callback"
	/// The browser page that runs the consent step and redirects back with the code.
	public static var authorizePage: URL { base.appending(path: "auth/desktop") }
	public static var exchange: URL { base.appending(path: "api/user/auth/desktop/exchange") }
	public static var refresh: URL { base.appending(path: "api/user/auth/mobile/refresh") }
	public static var logout: URL { base.appending(path: "api/user/auth/mobile/logout") }
	public static var tokens: URL { base.appending(path: "api/token/") }
	public static var selfUser: URL { base.appending(path: "api/user/self") }
	public static var chatCompletions: URL { base.appending(path: "v1/chat/completions") }
	public static var models: URL { base.appending(path: "v1/models") }
	/// Name of the API token the app manages for chat calls.
	public static let tokenName = "FlowsToken-Mobile"
}

public enum DirectAuthError: Error, Equatable {
	/// No stored session, or the server revoked it.
	case signedOut
	/// The callback URL was not the app's own auth callback, or its state did not match.
	case badCallback
	/// The user closed the consent page without approving.
	case cancelled
	/// The server refused a call; carries its HTTP status so 401s can trigger a refresh.
	case server(Int)
	case malformed
}

/// The account behind direct chat: one refresh-token-bound login, the `sk-` key the
/// server issued for chat calls, and a cached copy of the user row for display.
public struct DirectState: Equatable, Codable, Sendable {
	public var accessToken: String
	public var refreshToken: String
	/// Unix seconds; the access token is refreshed a little before this.
	public var accessExpiresAt: Double
	public var sessionSid: String
	public var userId: Int
	public var username: String
	public var displayName: String
	public var group: String
	/// The `sk-…` chat key minted for this device; nil until `ensureChatKey` ran.
	public var chatKey: String?

	public init(accessToken: String, refreshToken: String, accessExpiresAt: Double, sessionSid: String,
	            userId: Int, username: String, displayName: String, group: String, chatKey: String? = nil) {
		self.accessToken = accessToken
		self.refreshToken = refreshToken
		self.accessExpiresAt = accessExpiresAt
		self.sessionSid = sessionSid
		self.userId = userId
		self.username = username
		self.displayName = displayName
		self.group = group
		self.chatKey = chatKey
	}
}

/// What a sign-in attempt is made of: the URL the browser must open and the secrets
/// that prove the callback belongs to this attempt (PKCE verifier + state).
public struct DirectLoginAttempt: Sendable {
	public var url: URL
	public var state: String
	public var verifier: String
}

/// PKCE login against the FlowsToken account API plus the API-key housekeeping the
/// chat calls need. Tokens live in `secrets` (Keychain on device); only the displayed
/// account facts sit in `settings`.
public final class DirectAuth {
	static let stateKey = "vetta.direct.state"

	private let secrets: KeyValueStore
	private let fetch: DirectFetch
	/// Now in unix seconds, injectable for tests.
	private var clock: () -> Double
	private var pending: DirectLoginAttempt?

	public private(set) var state: DirectState?
	/// A login is being shown in the browser; finishing it takes the callback URL.
	public var signingIn: Bool { pending != nil }

	public init(secrets: KeyValueStore, fetch: DirectFetch? = nil, clock: @escaping () -> Double = { Date().timeIntervalSince1970 }) {
		self.secrets = secrets
		self.clock = clock
		self.fetch = fetch ?? DirectAuth.urlFetch
		if let raw = secrets.get(Self.stateKey), let data = raw.data(using: .utf8) {
			state = try? JSONDecoder().decode(DirectState.self, from: data)
		}
	}

	public static func urlFetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let (data, response) = try await URLSession.shared.data(for: request)
		guard let http = response as? HTTPURLResponse else { throw DirectAuthError.malformed }
		return (data, http)
	}

	// MARK: Login (PKCE)

	/// Builds the authorize URL; the app hands it to the system browser. The attempt
	/// stays pending until `finishLogin` consumes the callback or `cancelLogin` drops it.
	public func beginLogin() -> DirectLoginAttempt {
		let verifier = Base64URL.encode(RemoteCrypto.randomBytes(32))
		let challenge = Base64URL.encode(Data(SHA256.hash(data: Data(verifier.utf8))))
		let state = Base64URL.encode(RemoteCrypto.randomBytes(32))
		var components = URLComponents(url: DirectEndpoints.authorizePage, resolvingAgainstBaseURL: false)!
		components.queryItems = [
			URLQueryItem(name: "client_id", value: DirectEndpoints.clientId),
			URLQueryItem(name: "redirect_uri", value: DirectEndpoints.redirectURI),
			URLQueryItem(name: "state", value: state),
			URLQueryItem(name: "code_challenge", value: challenge),
			URLQueryItem(name: "code_challenge_method", value: "S256"),
		]
		let attempt = DirectLoginAttempt(url: components.url!, state: state, verifier: verifier)
		pending = attempt
		return attempt
	}

	public func cancelLogin() { pending = nil }

	/// Consumes `flowstoken://auth/callback?code=…&state=…`. Throws `badCallback` for a
	/// foreign URL or a state mismatch, `server` when the exchange is refused.
	public func finishLogin(_ callback: URL) async throws {
		guard let attempt = pending else { throw DirectAuthError.badCallback }
		guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
		      components.scheme == "flowstoken", components.host == "auth", components.path == "/callback"
		else { throw DirectAuthError.badCallback }
		if components.queryItems?.first(where: { $0.name == "error" })?.value == "access_denied" {
			pending = nil
			throw DirectAuthError.cancelled
		}
		guard let code = components.queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty,
		      components.queryItems?.first(where: { $0.name == "state" })?.value == attempt.state
		else { throw DirectAuthError.badCallback }
		pending = nil
		var request = Self.jsonRequest(DirectEndpoints.exchange)
		request.httpBody = try JSONSerialization.data(withJSONObject: [
			"client_id": DirectEndpoints.clientId,
			"redirect_uri": DirectEndpoints.redirectURI,
			"code": code,
			"code_verifier": attempt.verifier,
		])
		let data = try await send(request)
		state = try Self.readBundle(data, refreshIncluded: true)
		persist()
	}

	// MARK: Session upkeep

	/// A valid access token, refreshing through the mobile route when close to expiry.
	public func accessToken() async throws -> String {
		guard var state else { throw DirectAuthError.signedOut }
		if state.accessExpiresAt - 60 <= clock() {
			var request = URLRequest(url: DirectEndpoints.refresh)
			request.httpMethod = "POST"
			request.setValue(state.refreshToken, forHTTPHeaderField: "X-Auth-Refresh")
			request.setValue(state.sessionSid, forHTTPHeaderField: "X-Auth-Session")
			let data = try await send(request)
			state = try Self.readBundle(data, refreshIncluded: true, into: state)
			self.state = state
			persist()
		}
		return state.accessToken
	}

	/// Refreshes the displayed account facts (name, group, balance inputs) from /api/user/self.
	public func refreshAccount() async throws {
		guard var state else { throw DirectAuthError.signedOut }
		let request = try await authorizedRequest(DirectEndpoints.selfUser)
		let data = try await send(request)
		guard let body = try Self.unwrap(data),
		      let id = body["id"]?.numberValue.map(Int.init) ?? body["id"]?.stringValue.flatMap(Int.init)
		else { throw DirectAuthError.malformed }
		state.userId = id
		if let name = body["display_name"]?.stringValue { state.displayName = name }
		if let name = body["username"]?.stringValue { state.username = name }
		if let group = body["group"]?.stringValue { state.group = group }
		self.state = state
		persist()
	}

	/// The `sk-` key chat calls run under, creating the managed token on first use.
	public func chatKey() async throws -> String {
		if let key = state?.chatKey, !key.isEmpty { return key }
		guard let state else { throw DirectAuthError.signedOut }
		let listRequest = try await authorizedRequest(DirectEndpoints.tokens.appending(queryItems: [
			URLQueryItem(name: "p", value: "1"),
			URLQueryItem(name: "page_size", value: "100"),
		]))
		let listData = try await send(listRequest)
		guard let list = try Self.unwrap(listData) else { throw DirectAuthError.malformed }
		let rows = (list["items"]?.arrayValue ?? list["data"]?.arrayValue ?? [])
		var tokenId = rows.first { $0["name"]?.stringValue == DirectEndpoints.tokenName }?["id"]?.numberValue.map(Int.init)
		if tokenId == nil {
			var create = try await authorizedRequest(DirectEndpoints.tokens)
			create.httpMethod = "POST"
			create.httpBody = try JSONSerialization.data(withJSONObject: [
				"name": DirectEndpoints.tokenName,
				"remain_quota": 0,
				"expired_time": -1,
				"unlimited_quota": true,
				"model_limits_enabled": false,
				"model_limits": "",
				"allow_ips": "",
				"group": state.group,
			])
			let created = try await send(create)
			guard let body = try Self.unwrap(created), let id = body["id"]?.numberValue.map(Int.init) else { throw DirectAuthError.malformed }
			tokenId = id
		}
		// `appending(path:)` percent-encodes embedded slashes; build it relative instead.
		var reveal = try await authorizedRequest(URL(string: "api/token/\(tokenId!)/key", relativeTo: DirectEndpoints.base)!)
		reveal.httpMethod = "POST"
		reveal.httpBody = Data("{}".utf8)
		let revealed = try await send(reveal)
		guard let body = try Self.unwrap(revealed), let raw = body["key"]?.stringValue else { throw DirectAuthError.malformed }
		let key = raw.hasPrefix("sk-") ? raw : "sk-\(raw)"
		self.state?.chatKey = key
		persist()
		return key
	}

	/// Remote best effort, local always: the session dies either way.
	public func signOut() async {
		if let state {
			var request = URLRequest(url: DirectEndpoints.logout)
			request.httpMethod = "POST"
			request.setValue("Bearer \(state.accessToken)", forHTTPHeaderField: "Authorization")
			request.setValue(state.sessionSid, forHTTPHeaderField: "X-Auth-Session")
			request.setValue(state.refreshToken, forHTTPHeaderField: "X-Auth-Refresh")
			_ = try? await fetch(request)
		}
		state = nil
		pending = nil
		secrets.remove(Self.stateKey)
	}

	// MARK: Internals

	private func authorizedRequest(_ url: URL) async throws -> URLRequest {
		guard let state else { throw DirectAuthError.signedOut }
		var request = URLRequest(url: url)
		request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
		request.setValue(state.sessionSid, forHTTPHeaderField: "X-Auth-Session")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		return request
	}

	private static func jsonRequest(_ url: URL) -> URLRequest {
		var request = URLRequest(url: url)
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		return request
	}

	private func send(_ request: URLRequest) async throws -> Data {
		let (data, response) = try await fetch(request)
		if !(200 ..< 300).contains(response.statusCode) {
			if response.statusCode == 401 { throw DirectAuthError.signedOut }
			throw DirectAuthError.server(response.statusCode)
		}
		return data
	}

	private func persist() {
		guard let state, let data = try? JSONEncoder().encode(state), let text = String(data: data, encoding: .utf8) else { return }
		secrets.set(Self.stateKey, text)
	}

	/// Reads `{success, data:{access_token, access_expires_at, session:{sid}, user:{…},
	/// refresh_token?}}`. `refreshIncluded` is required on exchange/refresh: a response
	/// without a rotated token would strand the client.
	private static func readBundle(_ data: Data, refreshIncluded: Bool, into existing: DirectState? = nil) throws -> DirectState {
		guard let body = try unwrap(data),
		      let access = body["access_token"]?.stringValue,
		      let expires = body["access_expires_at"]?.numberValue ?? body["access_expires_at"]?.stringValue.flatMap(Double.init)
		else { throw DirectAuthError.malformed }
		var state = existing ?? DirectState(
			accessToken: access, refreshToken: "", accessExpiresAt: expires,
			sessionSid: body["session"]?["sid"]?.stringValue ?? "",
			userId: 0, username: "", displayName: "", group: "default"
		)
		state.accessToken = access
		state.accessExpiresAt = expires
		if let sid = body["session"]?["sid"]?.stringValue { state.sessionSid = sid }
		if let refresh = body["refresh_token"]?.stringValue { state.refreshToken = refresh }
		if refreshIncluded && state.refreshToken.isEmpty { throw DirectAuthError.malformed }
		if let user = body["user"] {
			if let id = user["id"]?.numberValue.map(Int.init) { state.userId = id }
			if let name = user["username"]?.stringValue { state.username = name }
			if let name = user["display_name"]?.stringValue { state.displayName = name }
			if let group = user["group"]?.stringValue { state.group = group }
		}
		return state
	}

	/// `{"success":true,"data":…}` → the data object; nil on a non-success envelope.
	private static func unwrap(_ data: Data) throws -> JSONValue? {
		let value = try JSONValue.parse(String(decoding: data, as: UTF8.self))
		guard value["success"]?.boolValue == true else {
			if value["success"] != nil { throw DirectAuthError.server(400) }
			// Some endpoints answer the bare object.
			return value.isObject ? value : nil
		}
		return value["data"]
	}
}
