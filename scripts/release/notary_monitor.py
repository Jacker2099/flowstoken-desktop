#!/usr/bin/env python3
"""Read the two original FlowsToken 0.6.9 submissions; never submit or publish."""

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

SOURCE_SHA = "4f66a2400331f870963c71cfd783b38b9d3440e6"
VERSION = "0.6.9"
TARGETS = {
    "9fd0aee3-e910-43aa-b1f3-870ae9cc1931": "FlowsToken-0.6.9-b2d7a516-c5eb-4396-afd8-0314bd34909a.zip",
    "6ce2b87f-b30f-4f61-8dc1-c7200345867f": "FlowsToken-0.6.9-0e1dca50-8686-4f6a-8f19-ee7e2bcd5e90.zip",
}
ALLOWED_USERNAME = "usa519"
STATUSES = {"In Progress", "Accepted", "Invalid", "Rejected"}
TERMINAL = {"Accepted", "Invalid", "Rejected"}
BINDING = hashlib.sha256(
    json.dumps([SOURCE_SHA, VERSION, TARGETS], sort_keys=True).encode()
).hexdigest()


class SafeFailure(Exception):
    """An allowlisted error name, without an argv, URL, body, or credential."""


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def new_state():
    return {
        "schema": 1,
        "binding": BINDING,
        "source_sha": SOURCE_SHA,
        "version": VERSION,
        "submissions": {
            sid: {"status": None, "failures": 0, "error_episode": 0}
            for sid in TARGETS
        },
        "notifications": {},
        "complete": False,
    }


def load_state(path):
    if not path.exists():
        return new_state()
    try:
        state = json.loads(path.read_text())
        if (
            state["schema"] != 1
            or state["binding"] != BINDING
            or state["source_sha"] != SOURCE_SHA
            or state["version"] != VERSION
            or set(state["submissions"]) != set(TARGETS)
            or not isinstance(state["notifications"], dict)
            or not isinstance(state["complete"], bool)
        ):
            raise ValueError()
        for entry in state["submissions"].values():
            if entry["status"] not in STATUSES | {None}:
                raise ValueError()
            for field in ("failures", "error_episode"):
                if type(entry[field]) is not int or entry[field] < 0:
                    raise ValueError()
        for record in state["notifications"].values():
            if record.get("delivery") not in {"confirmed", "uncertain"}:
                raise ValueError()
            if record["delivery"] == "confirmed" and (
                type(record.get("message_id")) is not int or record["message_id"] < 1
            ):
                raise ValueError()
        return state
    except (KeyError, TypeError, ValueError, OSError):
        raise SafeFailure("StateInvalid") from None


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, sort_keys=True, indent=2) + "\n")
    temporary.replace(path)


def validate_info(sid, info):
    if not isinstance(info, dict):
        raise SafeFailure("NotaryResponseInvalid")
    if info.get("id") != sid or info.get("name") != TARGETS[sid]:
        raise SafeFailure("NotaryIdentityMismatch")
    if info.get("status") not in STATUSES:
        raise SafeFailure("NotaryStatusUnknown")
    return info["status"]


def query_notary(sid, key_path, key_id, issuer):
    try:
        result = subprocess.run(
            [
                "xcrun", "notarytool", "info", sid,
                "--key", str(key_path), "--key-id", key_id, "--issuer", issuer,
                "--output-format", "json",
            ],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise SafeFailure("NotaryQueryTimeout") from None
    except OSError:
        raise SafeFailure("NotaryToolUnavailable") from None
    if result.returncode != 0:
        raise SafeFailure("NotaryQueryFailed")
    try:
        info = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise SafeFailure("NotaryResponseInvalid") from None
    return validate_info(sid, info)


def telegram_request(token, method, payload):
    request = urllib.request.Request(
        "https://api.telegram.org/bot" + token + "/" + method,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            output = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code in {400, 401, 403, 404, 429}:
            raise SafeFailure("TelegramRequestRejected") from None
        raise SafeFailure("TelegramTransportUnknown") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise SafeFailure("TelegramTransportUnknown") from None
    except (ValueError, TypeError):
        raise SafeFailure("TelegramResponseUnknown") from None
    except Exception:
        raise SafeFailure("TelegramTransportUnknown") from None
    if isinstance(output, dict) and output.get("ok") is False:
        raise SafeFailure("TelegramRequestRejected")
    if not isinstance(output, dict) or output.get("ok") is not True:
        raise SafeFailure("TelegramResponseUnknown")
    return output.get("result")


class Telegram:
    def __init__(self, token, chat_id):
        if not token or not chat_id.isdigit() or int(chat_id) < 1:
            raise SafeFailure("TelegramConfigurationMissing")
        self.token = token
        self.chat_id = int(chat_id)

    def send(self, message):
        chat = telegram_request(self.token, "getChat", {"chat_id": self.chat_id})
        if (
            not isinstance(chat, dict)
            or chat.get("id") != self.chat_id
            or chat.get("type") != "private"
            or str(chat.get("username", "")).lower() != ALLOWED_USERNAME
        ):
            raise SafeFailure("TelegramRecipientMismatch")
        try:
            sent = telegram_request(
                self.token,
                "sendMessage",
                {"chat_id": self.chat_id, "text": message, "disable_web_page_preview": True},
            )
        except SafeFailure as error:
            if str(error) in {"TelegramTransportUnknown", "TelegramResponseUnknown"}:
                raise SafeFailure("TelegramDeliveryUnknown") from None
            raise
        if (
            not isinstance(sent, dict)
            or type(sent.get("message_id")) is not int
            or sent["message_id"] < 1
            or not isinstance(sent.get("chat"), dict)
            or sent["chat"].get("id") != self.chat_id
        ):
            raise SafeFailure("TelegramDeliveryUnknown")
        return sent["message_id"]


def notify(state, event, message, sender, persist):
    record = state["notifications"].get(event)
    if record:
        if record["delivery"] == "uncertain":
            raise SafeFailure("TelegramDeliveryNeedsReview")
        return
    try:
        message_id = sender(message)
    except SafeFailure as error:
        if str(error) == "TelegramDeliveryUnknown":
            state["notifications"][event] = {"delivery": "uncertain", "at": timestamp()}
            persist(state)
        raise
    if type(message_id) is not int or message_id < 1:
        raise SafeFailure("TelegramResponseInvalid")
    state["notifications"][event] = {
        "delivery": "confirmed", "message_id": message_id, "at": timestamp()
    }
    persist(state)
    print(f"FlowsToken 0.6.9 Telegram delivery confirmed: {event}; message_id={message_id}")


def poll(state, query, sender, persist, test_notification=False):
    if state["complete"]:
        print("FlowsToken 0.6.9: terminal notifications already confirmed; no queries.")
        return 0
    events = []
    query_failed = False
    for sid in TARGETS:
        entry = state["submissions"][sid]
        try:
            status = query(sid)
            if status not in STATUSES:
                raise SafeFailure("NotaryStatusUnknown")
        except SafeFailure as error:
            query_failed = True
            if entry["failures"] == 0:
                entry["error_episode"] += 1
            entry["failures"] += 1
            entry["query_error"] = str(error)
            print(f"FlowsToken 0.6.9 {sid}: {error}")
            if entry["failures"] >= 3:
                events.append((
                    f"query-error:{sid}:{entry['error_episode']}",
                    "FlowsToken 0.6.9 云端公证监控连续三次查询失败，需要检查。"
                    f"\n申请：{sid}\n这不表示苹果拒绝了公证。",
                ))
            continue
        entry["failures"] = 0
        entry.pop("query_error", None)
        entry["status"] = status
        entry["queried_at"] = timestamp()
        print(f"FlowsToken 0.6.9 {sid}: {status}")
        if status in TERMINAL:
            label = {"Accepted": "已通过", "Invalid": "未通过", "Rejected": "已拒绝"}[status]
            events.append((
                f"status:{sid}:{status}",
                f"FlowsToken 0.6.9：苹果公证{label}。\n申请：{sid}"
                "\n尚未自动发布；保留原包和申请，后续需恢复验证及发布。",
            ))
    # Persist query/error progress before notification: a send failure must not lose it.
    persist(state)
    fresh_all_accepted = not query_failed and all(
        state["submissions"][sid]["status"] == "Accepted" for sid in TARGETS
    )
    if fresh_all_accepted:
        events.append((
            "all-accepted",
            "FlowsToken 0.6.9 两项苹果公证全部通过。"
            "\n下一步使用原申请恢复票据装订、最终验证和发布；尚未自动发布。",
        ))
    if test_notification and not query_failed:
        result = "两项均已通过" if fresh_all_accepted else "两项尚未确认全部通过"
        events.append((
            "monitor-connected",
            f"FlowsToken 0.6.9 云端监控已接通，电脑可以关闭。\n当前状态：{result}。"
            "\n这是通知连接测试，不是公证通过通知。",
        ))
    delivery_failed = False
    for event, message in events:
        try:
            notify(state, event, message, sender, persist)
        except SafeFailure as error:
            print(f"FlowsToken 0.6.9 notification: {error}")
            delivery_failed = True
    if not query_failed and not delivery_failed:
        status_events = [f"status:{sid}:{state['submissions'][sid]['status']}" for sid in TARGETS]
        terminal = all(state["submissions"][sid]["status"] in TERMINAL for sid in TARGETS)
        confirmed = all(
            state["notifications"].get(event, {}).get("delivery") == "confirmed"
            for event in status_events
        )
        if terminal and confirmed:
            if not fresh_all_accepted or state["notifications"].get("all-accepted", {}).get("delivery") == "confirmed":
                state["complete"] = True
                persist(state)
    return 1 if delivery_failed or (test_notification and query_failed) else 0


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=pathlib.Path, required=True)
    parser.add_argument("--test-notification", action="store_true")
    args = parser.parse_args(argv)
    try:
        state = load_state(args.state)
        if state["complete"]:
            return poll(state, None, None, None)
        encoded = os.environ.get("SECRET_APPLE_API_KEY_P8_BASE64", "")
        key_id = os.environ.get("SECRET_APPLE_API_KEY_ID", "")
        issuer = os.environ.get("SECRET_APPLE_API_ISSUER", "")
        if not encoded or not key_id or not issuer:
            raise SafeFailure("NotaryCredentialsMissing")
        import base64

        try:
            private_key = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise SafeFailure("NotaryKeyEncodingInvalid") from None
        if not private_key.startswith(b"-----BEGIN PRIVATE KEY-----"):
            raise SafeFailure("NotaryKeyEncodingInvalid")
        telegram = Telegram(
            os.environ.get("NOTARY_TELEGRAM_BOT_TOKEN", ""),
            os.environ.get("NOTARY_TELEGRAM_CHAT_ID", ""),
        )
        with tempfile.TemporaryDirectory(prefix="flowstoken-notary-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
            key_path = pathlib.Path(temporary) / "auth.p8"
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as key_file:
                key_file.write(private_key)
            try:
                return poll(
                    state,
                    lambda sid: query_notary(sid, key_path, key_id, issuer),
                    telegram.send,
                    lambda value: save_state(args.state, value),
                    args.test_notification,
                )
            finally:
                key_path.unlink(missing_ok=True)
    except SafeFailure as error:
        print(f"FlowsToken 0.6.9 monitor: {error}")
        return 1
    except Exception:
        # The traceback may include request URLs or subprocess arguments containing credentials.
        print("FlowsToken 0.6.9 monitor: InternalMonitorError")
        return 1


if __name__ == "__main__":
    sys.exit(main())
