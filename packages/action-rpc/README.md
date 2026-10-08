# @vetta/action-rpc

Localhost HTTP JSON RPC transport for Vetta Desktop capabilities.

This package owns transport, protocol, server, and client helpers only. It does
not define desktop business capabilities.

The server supports independently registered namespaces on one authenticated
endpoint:

- `actions.*` for regular app actions.
- `debug.*` for development-only debug capabilities.
- `models.resolveCredential` for optional, authenticated, process-local managed model credentials.

The credential client accepts only loopback IP endpoints, refuses redirects, and times out.
Its response must never be logged or persisted. The Desktop host owns account, provider,
destination and permission checks; the transport only validates the request contract.

`startActionRpcServer()` remains as the action-only compatibility wrapper.
