package org.vetta.android.domain.direct

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.contentType
import org.vetta.android.domain.remote.pairing.SecretStore
import org.vetta.android.domain.remote.protocol.RemoteCrypto

/**
 * The account's endpoints, on FlowsToken's NewAPI host. The sign-in rides the desktop
 * SSO contract with `client_id=flowstoken-mobile`; chat calls use the OpenAI surface.
 */
object DirectEndpoints {
    const val BASE_URL = "https://www.flowstoken.com"
    const val CLIENT_ID = "flowstoken-mobile"
    const val REDIRECT_URI = "flowstoken://auth/callback"

    /** The managed chat token name, shared with the desktop's mobile convention. */
    const val TOKEN_NAME = "FlowsToken-Mobile"

    const val AUTHORIZE = "$BASE_URL/auth/desktop"
    const val EXCHANGE = "$BASE_URL/api/user/auth/desktop/exchange"
    const val REFRESH = "$BASE_URL/api/user/auth/mobile/refresh"
    const val LOGOUT = "$BASE_URL/api/user/auth/mobile/logout"
    const val SELF = "$BASE_URL/api/user/self"
    const val TOKENS = "$BASE_URL/api/token/"
    const val MODELS = "$BASE_URL/v1/models"
    const val CHAT_COMPLETIONS = "$BASE_URL/v1/chat/completions"

    fun tokenKey(id: Int) = "${TOKENS}$id/key"
}

/** What a network call is asked for; the platform layer turns it into HTTP. */
data class DirectRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
)

/** `(statusCode, body)`; the caller maps errors. Injection seam for tests. */
typealias DirectFetch = suspend (DirectRequest) -> Pair<Int, String>

/** Sign-in and token problems worded without secrets. */
sealed class DirectAuthError : Exception() {
    data object SignedOut : DirectAuthError()

    data object BadCallback : DirectAuthError()

    data object Cancelled : DirectAuthError()

    data object Malformed : DirectAuthError()

    data class Server(val status: Int) : DirectAuthError()
}

/** The credential bundle the secrets store keeps across launches. */
@Serializable
data class DirectState(
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAt: Double,
    val sessionSid: String,
    val userId: Int,
    val username: String,
    val displayName: String,
    val group: String,
    val chatKey: String? = null,
) {
    /** What the UI may show; the tokens never leave [DirectAuth]. */
    val accountName: String
        get() = displayName.ifEmpty { username }
}

/** A PKCE login in flight; `url` is what the browser opens. */
data class DirectLoginAttempt(val url: String, val state: String, val verifier: String)

/**
 * The phone's own sign-in: PKCE against the web authorize page, exchange for a session,
 * refresh over the mobile header route, and the managed `sk-` chat key it creates on
 * first use. Lives in the secrets store; HTTP is injected so tests never touch a network.
 */
class DirectAuth(
    private val secrets: SecretStore,
    private val fetch: DirectFetch,
    private val clock: () -> Double = { System.currentTimeMillis() / 1000.0 },
    private val randomBytes: (Int) -> ByteArray = RemoteCrypto::randomBytes,
) {
    var state: DirectState? = load()
        private set

    /** Tests seed a stored session without the browser round-trip. */
    internal fun restore(state: DirectState) {
        this.state = state
        persist()
    }

    private var pending: DirectLoginAttempt? = null
    private val refreshLock = Mutex()
    private val keyLock = Mutex()

    // MARK: Sign-in

    /** The authorize-page URL the browser must open; keep the attempt for the callback. */
    fun beginLogin(): DirectLoginAttempt {
        val state = RemoteCrypto.toBase64Url(randomBytes(24))
        val verifier = RemoteCrypto.toBase64Url(randomBytes(32))
        val challenge = RemoteCrypto.toBase64Url(sha256(verifier))
        val url =
            buildString {
                append(DirectEndpoints.AUTHORIZE)
                append("?client_id=").append(encode(DirectEndpoints.CLIENT_ID))
                append("&redirect_uri=").append(encode(DirectEndpoints.REDIRECT_URI))
                append("&state=").append(state)
                append("&code_challenge=").append(challenge)
                append("&code_challenge_method=S256")
            }
        return DirectLoginAttempt(url, state, verifier).also { pending = it }
    }

    fun cancelLogin() {
        pending = null
    }

    /**
     * Consumes `flowstoken://auth/callback?code=…&state=…`. Throws [DirectAuthError.BadCallback]
     * on a foreign URL or state mismatch, [DirectAuthError.Cancelled] on a denied consent.
     */
    suspend fun finishLogin(callback: String) {
        val attempt = pending ?: throw DirectAuthError.BadCallback
        val uri = try {
            URI(callback)
        } catch (_: Exception) {
            throw DirectAuthError.BadCallback
        }
        if (uri.scheme?.lowercase() != "flowstoken" || uri.host?.lowercase() != "auth" || uri.path != "/callback") {
            throw DirectAuthError.BadCallback
        }
        val query = queryParams(uri.rawQuery)
        if (query["error"] == "access_denied") {
            pending = null
            throw DirectAuthError.Cancelled
        }
        val code = query["code"]?.takeIf { it.isNotEmpty() }
        if (code == null || query["state"] != attempt.state) throw DirectAuthError.BadCallback
        pending = null
        val body =
            send(
                DirectRequest(
                    method = "POST",
                    url = DirectEndpoints.EXCHANGE,
                    headers = mapOf("Content-Type" to "application/json"),
                    body =
                        buildJsonObject {
                            put("client_id", DirectEndpoints.CLIENT_ID)
                            put("redirect_uri", DirectEndpoints.REDIRECT_URI)
                            put("code", code)
                            put("code_verifier", attempt.verifier)
                        }.toString(),
                ),
            )
        state = readBundle(body)
        persist()
    }

    // MARK: Session upkeep

    /** A valid access token, refreshing through the mobile route when close to expiry. */
    suspend fun accessToken(): String {
        val current = state ?: throw DirectAuthError.SignedOut
        if (current.accessExpiresAt - 60 > clock()) return current.accessToken
        refreshLock.withLock {
            val again = state ?: throw DirectAuthError.SignedOut
            if (again.accessExpiresAt - 60 > clock()) return again.accessToken
            val body =
                send(
                    DirectRequest(
                        method = "POST",
                        url = DirectEndpoints.REFRESH,
                        headers =
                            mapOf(
                                "X-Auth-Refresh" to again.refreshToken,
                                "X-Auth-Session" to again.sessionSid,
                            ),
                    ),
                )
            val refreshed = readBundle(body, into = again)
            state = refreshed
            persist()
            return refreshed.accessToken
        }
    }

    /** The `sk-` key chat calls run under, creating the managed token on first use. */
    suspend fun chatKey(): String {
        state?.chatKey?.takeIf { it.isNotEmpty() }?.let { return it }
        if (state == null) throw DirectAuthError.SignedOut
        keyLock.withLock {
            state?.chatKey?.takeIf { it.isNotEmpty() }?.let { return it }
            val current = state ?: throw DirectAuthError.SignedOut
            val list = unwrap(send(authorized(DirectEndpoints.TOKENS + "?p=1&page_size=100")))
            val rows =
                (list as? JsonObject)?.let { it["items"] ?: it["data"] } as? JsonArray ?: JsonArray(emptyList())
            var tokenId =
                rows
                    .firstOrNull { (it as? JsonObject)?.get("name")?.jsonPrimitive?.contentOrNull == DirectEndpoints.TOKEN_NAME }
                    ?.let { (it as JsonObject)["id"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() }
            if (tokenId == null) {
                val created =
                    unwrap(
                        send(
                            authorized(
                                DirectEndpoints.TOKENS,
                                method = "POST",
                                body =
                                    buildJsonObject {
                                        put("name", DirectEndpoints.TOKEN_NAME)
                                        put("remain_quota", 0)
                                        put("expired_time", -1)
                                        put("unlimited_quota", true)
                                        put("model_limits_enabled", false)
                                        put("model_limits", "")
                                        put("allow_ips", "")
                                        put("group", current.group)
                                    }.toString(),
                            ),
                        ),
                    )
                tokenId =
                    (created as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull?.toIntOrNull()
                        ?: throw DirectAuthError.Malformed
            }
            val revealed = unwrap(send(authorized(DirectEndpoints.tokenKey(tokenId), method = "POST", body = "{}")))
            val raw = (revealed as? JsonObject)?.get("key")?.jsonPrimitive?.contentOrNull ?: throw DirectAuthError.Malformed
            val key = if (raw.startsWith("sk-")) raw else "sk-$raw"
            state = current.copy(chatKey = key)
            persist()
            return key
        }
    }

    /** Refreshes the displayed account facts (name, group) from /api/user/self. */
    suspend fun refreshAccount() {
        val current = state ?: throw DirectAuthError.SignedOut
        val body = unwrap(send(authorized(DirectEndpoints.SELF))) as? JsonObject ?: throw DirectAuthError.Malformed
        val id = body["id"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: throw DirectAuthError.Malformed
        state =
            current.copy(
                userId = id,
                username = body["username"]?.jsonPrimitive?.contentOrNull ?: current.username,
                displayName = body["display_name"]?.jsonPrimitive?.contentOrNull ?: current.displayName,
                group = body["group"]?.jsonPrimitive?.contentOrNull ?: current.group,
            )
        persist()
    }

    /** Remote best effort, local always: the session dies either way. */
    suspend fun signOut() {
        val current = state
        state = null
        secrets.remove(STATE_KEY)
        if (current != null) {
            try {
                send(
                    DirectRequest(
                        method = "POST",
                        url = DirectEndpoints.LOGOUT,
                        headers =
                            mapOf(
                                "Authorization" to "Bearer ${current.accessToken}",
                                "X-Auth-Refresh" to current.refreshToken,
                                "X-Auth-Session" to current.sessionSid,
                            ),
                        body = "{}",
                    ),
                )
            } catch (_: Throwable) {
            }
        }
    }

    // MARK: Plumbing

    private suspend fun authorized(url: String, method: String = "GET", body: String? = null): DirectRequest =
        DirectRequest(
            method = method,
            url = url,
            headers =
                mapOf(
                    "Authorization" to "Bearer ${accessToken()}",
                    "Content-Type" to "application/json",
                ),
            body = body,
        )

    private suspend fun send(request: DirectRequest): String {
        val (status, body) = fetch(request)
        if (status !in 200..299) throw DirectAuthError.Server(status)
        return body
    }

    /** The API wraps payloads in `{success, data, message}`; failures throw. */
    private fun unwrap(body: String): JsonElement {
        val value = Json.parseToJsonElement(body)
        val obj = value as? JsonObject
        if (obj?.get("success")?.jsonPrimitive?.booleanOrNull == true) {
            return obj["data"] ?: throw DirectAuthError.Malformed
        }
        if (obj != null && obj.containsKey("success")) throw DirectAuthError.Server(400)
        return value
    }

    /** Reads an exchange/refresh bundle into state; a missing refresh token keeps the old one. */
    private fun readBundle(body: String, into: DirectState? = null): DirectState {
        val obj = unwrap(body) as? JsonObject ?: throw DirectAuthError.Malformed
        val user = obj["user"] as? JsonObject
        val session = obj["session"] as? JsonObject
        val accessToken = obj["access_token"]?.jsonPrimitive?.contentOrNull ?: throw DirectAuthError.Malformed
        val refreshToken = obj["refresh_token"]?.jsonPrimitive?.contentOrNull ?: into?.refreshToken ?: throw DirectAuthError.Malformed
        val expiresAt = obj["access_expires_at"]?.jsonPrimitive?.doubleOrNull ?: into?.accessExpiresAt ?: 0.0
        val sid = session?.get("sid")?.jsonPrimitive?.contentOrNull ?: into?.sessionSid ?: throw DirectAuthError.Malformed
        return DirectState(
            accessToken = accessToken,
            refreshToken = refreshToken,
            accessExpiresAt = expiresAt,
            sessionSid = sid,
            userId = user?.get("id")?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: into?.userId ?: 0,
            username = user?.get("username")?.jsonPrimitive?.contentOrNull ?: into?.username ?: "",
            displayName = user?.get("display_name")?.jsonPrimitive?.contentOrNull ?: into?.displayName ?: "",
            group = user?.get("group")?.jsonPrimitive?.contentOrNull ?: into?.group ?: "",
            chatKey = into?.chatKey,
        )
    }

    private fun persist() {
        val current = state ?: return
        secrets.set(STATE_KEY, json.encodeToString(DirectState.serializer(), current))
    }

    private fun load(): DirectState? =
        secrets.get(STATE_KEY)?.let { runCatching { json.decodeFromString(DirectState.serializer(), it) }.getOrNull() }

    companion object {
        const val STATE_KEY = "flowstoken.direct.state"

        private val json = Json { ignoreUnknownKeys = true }

        private val http by lazy {
            io.ktor.client.HttpClient(org.vetta.android.core.net.platformHttpClientEngine()) { expectSuccess = false }
        }

        /** Real network: ktor over the platform engine, status plus body text. */
        val ktorFetch: DirectFetch = { request ->
            val response =
                http.request(io.ktor.http.Url(request.url)) {
                    method = io.ktor.http.HttpMethod.parse(request.method)
                    request.headers.forEach { (name, value) -> header(name, value) }
                    if (request.body != null) {
                        contentType(io.ktor.http.ContentType.Application.Json)
                        setBody(request.body)
                    }
                }
            response.status.value to response.bodyAsText()
        }

        private fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8)

        private fun sha256(value: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(value.encodeToByteArray())

        private fun queryParams(rawQuery: String?): Map<String, String> =
            rawQuery?.split('&')
                ?.mapNotNull { part ->
                    val eq = part.indexOf('=')
                    val name = if (eq >= 0) part.substring(0, eq) else part
                    val value = if (eq >= 0) part.substring(eq + 1) else ""
                    name.takeIf { it.isNotEmpty() }?.let { it to URLDecoder.decode(value, Charsets.UTF_8) }
                }
                ?.toMap()
                .orEmpty()
    }
}
