package org.vetta.android.domain.direct

import com.russhwolf.settings.MapSettings
import org.vetta.android.domain.remote.pairing.SettingsSecretStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

private const val BUNDLE =
    """{"success":true,"data":{"access_token":"at1","refresh_token":"rt1","access_expires_at":9999999999.0,"session":{"sid":"s1"},"user":{"id":7,"username":"kim","display_name":"Kim","group":"smart"}}}"""

private val STORED =
    DirectState(
        accessToken = "at1",
        refreshToken = "rt1",
        accessExpiresAt = 9999999999.0,
        sessionSid = "s1",
        userId = 7,
        username = "kim",
        displayName = "Kim",
        group = "smart",
    )

/** Records every request and answers by URL; no network ever leaves the test. */
private class FakeFetch : DirectFetch {
    val requests = mutableListOf<DirectRequest>()
    var onRequest: (DirectRequest) -> Pair<Int, String> = { 200 to "{}" }

    override suspend fun invoke(request: DirectRequest): Pair<Int, String> {
        requests += request
        return onRequest(request)
    }
}

private fun signedInAuth(fake: FakeFetch = FakeFetch(), secrets: SettingsSecretStore = SettingsSecretStore(MapSettings())): DirectAuth =
    DirectAuth(secrets, fake).apply { restore(STORED) }

class DirectAuthTest {
    @Test
    fun beginLoginBuildsThePkceAuthorizeUrl() {
        val attempt = DirectAuth(SettingsSecretStore(MapSettings()), FakeFetch()).beginLogin()
        assertTrue(attempt.url.startsWith("${DirectEndpoints.AUTHORIZE}?"), "authorize URL: ${attempt.url}")
        assertTrue(attempt.url.contains("client_id=${DirectEndpoints.CLIENT_ID}"))
        assertTrue(attempt.url.contains("redirect_uri=flowstoken%3A%2F%2Fauth%2Fcallback"))
        assertTrue(attempt.url.contains("state=${attempt.state}"))
        assertTrue(attempt.url.contains("code_challenge_method=S256"))
        assertTrue(attempt.url.contains("code_challenge="), "the S256 challenge travels with the URL")
    }

    @Test
    fun finishLoginRejectsAForeignCallback() =
        runTest {
            val auth = DirectAuth(SettingsSecretStore(MapSettings()), FakeFetch())
            auth.beginLogin()
            assertFailsWith<DirectAuthError.BadCallback> {
                auth.finishLogin("flowstoken://auth/callback?code=c&state=wrong")
            }
            assertFailsWith<DirectAuthError.BadCallback> {
                auth.finishLogin("https://example.com/auth/callback?code=c&state=any")
            }
        }

    @Test
    fun finishLoginExchangesTheCodeAndKeepsTheBundle() =
        runTest {
            val fake = FakeFetch().apply { onRequest = { 200 to BUNDLE } }
            val auth = DirectAuth(SettingsSecretStore(MapSettings()), fake)
            val attempt = auth.beginLogin()
            auth.finishLogin("flowstoken://auth/callback?code=ok&state=${attempt.state}")

            val state = assertNotNull(auth.state)
            assertEquals("at1", state.accessToken)
            assertEquals("rt1", state.refreshToken)
            assertEquals("s1", state.sessionSid)
            assertEquals("Kim", state.accountName)
            assertEquals("smart", state.group)

            val exchange = fake.requests.single()
            assertEquals(DirectEndpoints.EXCHANGE, exchange.url)
            assertTrue(exchange.body!!.contains("\"code_verifier\":\"${attempt.verifier}\""))
        }

    @Test
    fun accessTokenRefreshesThroughTheMobileHeaders() =
        runTest {
            val fake =
                FakeFetch().apply {
                    onRequest = { 200 to """{"success":true,"data":{"access_token":"at2","refresh_token":"rt2","access_expires_at":9999999999.0}}""" }
                }
            val secrets = SettingsSecretStore(MapSettings())
            val auth = signedInAuth(fake, secrets)
            auth.restore(STORED.copy(accessExpiresAt = 1.0))

            assertEquals("at2", auth.accessToken())
            val refresh = fake.requests.last()
            assertEquals(DirectEndpoints.REFRESH, refresh.url)
            assertEquals("rt1", refresh.headers["X-Auth-Refresh"])
            assertEquals("s1", refresh.headers["X-Auth-Session"])
            // The rotated refresh token is what the secrets store now holds.
            assertTrue(secrets.get(DirectAuth.STATE_KEY)!!.contains("rt2"))
        }

    @Test
    fun chatKeyCreatesTheManagedTokenInTheUsersGroupAndReusesIt() =
        runTest {
            val fake =
                FakeFetch().apply {
                    onRequest = { request ->
                        when {
                            request.method == "GET" && request.url.contains("api/token") ->
                                200 to """{"success":true,"data":{"items":[]}}"""
                            request.method == "POST" && request.url.contains("/key") ->
                                200 to """{"success":true,"data":{"key":"abc"}}"""
                            request.method == "POST" && request.url.contains("api/token") ->
                                200 to """{"success":true,"data":{"id":42}}"""
                            else -> 200 to "{}"
                        }
                    }
                }
            val auth = signedInAuth(fake)

            assertEquals("sk-abc", auth.chatKey())
            val create = fake.requests.first { it.method == "POST" && it.url.contains("api/token") && !it.url.contains("/key") }
            assertTrue(create.body!!.contains("\"group\":\"smart\""))
            assertTrue(create.body!!.contains("\"name\":\"${DirectEndpoints.TOKEN_NAME}\""))

            val calls = fake.requests.size
            assertEquals("sk-abc", auth.chatKey())
            assertEquals(calls, fake.requests.size, "the cached key is reused")
        }

    @Test
    fun signOutClearsTheStoredState() =
        runTest {
            val secrets = SettingsSecretStore(MapSettings())
            val auth = signedInAuth(FakeFetch(), secrets)
            assertNotNull(secrets.get(DirectAuth.STATE_KEY))
            auth.signOut()
            assertNull(auth.state)
            assertNull(secrets.get(DirectAuth.STATE_KEY))
        }
}
