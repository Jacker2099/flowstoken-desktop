import contextlib
import base64
import importlib.util
import io
import json
import pathlib
import subprocess
import tempfile
import urllib.error
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("notary_monitor.py")
spec = importlib.util.spec_from_file_location("notary_monitor", SCRIPT)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)
IDS = list(monitor.TARGETS)


class MonitorTests(unittest.TestCase):
    def run_poll(self, state, query, sent, test=False):
        saved = []

        def sender(message):
            sent.append(message)
            return len(sent)

        with contextlib.redirect_stdout(io.StringIO()):
            result = monitor.poll(
                state, query, sender,
                lambda value: saved.append(json.loads(json.dumps(value))), test,
            )
        return result, saved

    def test_pending_then_one_acceptance_then_all_accepted_is_deduplicated(self):
        state = monitor.new_state()
        sent = []
        statuses = dict.fromkeys(IDS, "In Progress")
        result, _ = self.run_poll(state, statuses.__getitem__, sent)
        self.assertEqual(result, 0)
        self.assertEqual(sent, [])
        statuses[IDS[0]] = "Accepted"
        self.run_poll(state, statuses.__getitem__, sent)
        self.assertEqual(len(sent), 1)
        self.assertFalse(state["complete"])
        self.run_poll(state, statuses.__getitem__, sent)
        self.assertEqual(len(sent), 1)
        statuses[IDS[1]] = "Accepted"
        self.run_poll(state, statuses.__getitem__, sent)
        self.assertEqual(len(sent), 3)
        self.assertIn("全部通过", sent[-1])
        self.assertTrue(state["complete"])
        # A cached terminal state skips Apple and Telegram entirely.
        self.run_poll(state, lambda sid: self.fail("must not query"), sent)
        self.assertEqual(len(sent), 3)

    def test_rejection_is_not_announced_as_acceptance_and_stops_after_both_terminal(self):
        state = monitor.new_state()
        sent = []
        statuses = {IDS[0]: "Rejected", IDS[1]: "Invalid"}
        self.run_poll(state, statuses.__getitem__, sent)
        self.assertEqual(len(sent), 2)
        self.assertIn("已拒绝", sent[0])
        self.assertIn("未通过", sent[1])
        self.assertFalse(any("全部通过" in message for message in sent))
        self.assertTrue(state["complete"])

    def test_one_query_error_does_not_hide_other_acceptance_and_alerts_after_three(self):
        state = monitor.new_state()
        sent = []

        def query(sid):
            if sid == IDS[0]:
                raise monitor.SafeFailure("NotaryQueryFailed")
            return "Accepted"

        for _ in range(3):
            self.run_poll(state, query, sent)
        self.assertEqual(len(sent), 2)
        self.assertIn("已通过", sent[0])
        self.assertIn("连续三次查询失败", sent[1])
        self.assertFalse(state["complete"])
        self.assertIsNone(state["submissions"][IDS[0]]["status"])
        self.run_poll(state, query, sent)
        self.assertEqual(len(sent), 2)
        self.run_poll(state, lambda sid: "In Progress", sent)
        self.assertEqual(state["submissions"][IDS[0]]["failures"], 0)
        for _ in range(3):
            self.run_poll(state, query, sent)
        self.assertEqual(len(sent), 3)

    def test_unknown_send_is_not_confirmed_or_blindly_retried(self):
        state = monitor.new_state()
        calls = []
        persisted = []

        def sender(message):
            calls.append(message)
            raise monitor.SafeFailure("TelegramDeliveryUnknown")

        with self.assertRaisesRegex(monitor.SafeFailure, "TelegramDeliveryUnknown"):
            monitor.notify(state, "event", "message", sender, persisted.append)
        self.assertEqual(state["notifications"]["event"]["delivery"], "uncertain")
        self.assertNotIn("message_id", state["notifications"]["event"])
        self.assertEqual(len(persisted), 1)
        with self.assertRaisesRegex(monitor.SafeFailure, "TelegramDeliveryNeedsReview"):
            monitor.notify(state, "event", "message", sender, persisted.append)
        self.assertEqual(len(calls), 1)

    def test_explicit_send_rejection_is_retryable_and_not_deduplicated(self):
        state = monitor.new_state()
        with self.assertRaisesRegex(monitor.SafeFailure, "TelegramRequestRejected"):
            monitor.notify(
                state, "event", "message",
                mock.Mock(side_effect=monitor.SafeFailure("TelegramRequestRejected")),
                lambda value: None,
            )
        self.assertNotIn("event", state["notifications"])
        monitor.notify(state, "event", "message", lambda message: 27, lambda value: None)
        self.assertEqual(state["notifications"]["event"]["message_id"], 27)

    def test_test_notification_requires_both_real_query_successes_and_does_not_claim_pass(self):
        state = monitor.new_state()
        sent = []
        result, _ = self.run_poll(
            state,
            mock.Mock(side_effect=monitor.SafeFailure("NotaryQueryTimeout")),
            sent, True,
        )
        self.assertEqual(result, 1)
        self.assertEqual(sent, [])
        result, _ = self.run_poll(state, lambda sid: "In Progress", sent, True)
        self.assertEqual(result, 0)
        self.assertEqual(len(sent), 1)
        self.assertIn("电脑可以关闭", sent[0])
        self.assertIn("尚未确认全部通过", sent[0])
        self.assertIn("不是公证通过通知", sent[0])
        self.assertFalse(state["complete"])
        self.assertEqual(state["submissions"][IDS[0]]["status"], "In Progress")

    def test_apple_response_identity_and_zip_name_must_both_match(self):
        sid = IDS[0]
        info = {"id": sid, "name": monitor.TARGETS[sid], "status": "Accepted"}
        self.assertEqual(monitor.validate_info(sid, info), "Accepted")
        for changed in ({"id": IDS[1]}, {"name": "FlowsToken.zip"}, {"status": "Queued"}):
            with self.assertRaises(monitor.SafeFailure):
                monitor.validate_info(sid, {**info, **changed})

    def test_notary_external_command_is_info_only_and_errors_hide_credentials(self):
        sid = IDS[0]
        result = subprocess.CompletedProcess([], 0, json.dumps({
            "id": sid, "name": monitor.TARGETS[sid], "status": "In Progress",
        }), "")
        with mock.patch.object(monitor.subprocess, "run", return_value=result) as run:
            self.assertEqual(
                monitor.query_notary(sid, pathlib.Path("private-key"), "key-id", "issuer"),
                "In Progress",
            )
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], ["xcrun", "notarytool", "info", sid])
        self.assertNotIn("submit", argv)
        with mock.patch.object(monitor.subprocess, "run", side_effect=subprocess.TimeoutExpired(["secret"], 90)):
            with self.assertRaisesRegex(monitor.SafeFailure, "^NotaryQueryTimeout$"):
                monitor.query_notary(sid, pathlib.Path("private-key"), "key-id", "issuer")

    def test_wrong_telegram_recipient_blocks_send_and_missing_message_id_is_uncertain(self):
        telegram = monitor.Telegram("private-token", "123456")
        for bad in (
            {"id": 123456, "type": "private", "username": "other"},
            {"id": 123457, "type": "private", "username": "USA519"},
            {"id": 123456, "type": "group", "username": "USA519"},
        ):
            with mock.patch.object(monitor, "telegram_request", return_value=bad) as request:
                with self.assertRaisesRegex(monitor.SafeFailure, "TelegramRecipientMismatch"):
                    telegram.send("message")
                self.assertEqual([call.args[1] for call in request.call_args_list], ["getChat"])
        with mock.patch.object(monitor, "telegram_request", side_effect=[
            {"id": 123456, "type": "private", "username": "USA519"},
            {"chat": {"id": 123456}},
        ]):
            with self.assertRaisesRegex(monitor.SafeFailure, "TelegramDeliveryUnknown"):
                telegram.send("message")

    def test_telegram_http_server_error_has_unknown_delivery_and_rate_limit_is_rejected(self):
        for status, expected in ((500, "TelegramTransportUnknown"), (429, "TelegramRequestRejected")):
            with mock.patch.object(monitor.urllib.request, "urlopen", side_effect=urllib.error.HTTPError(
                "https://api.telegram.org/botSECRET/sendMessage", status, "sensitive", None, None,
            )):
                with self.assertRaisesRegex(monitor.SafeFailure, "^" + expected + "$"):
                    monitor.telegram_request("private-token", "sendMessage", {"chat_id": 123456})

    def test_main_writes_private_key_only_with_0600_and_removes_it_after_query(self):
        with tempfile.TemporaryDirectory() as temporary:
            key_paths = []
            private_key = b"-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n"

            def external_query(argv, **kwargs):
                self.assertEqual(argv[:3], ["xcrun", "notarytool", "info"])
                key = pathlib.Path(argv[argv.index("--key") + 1])
                key_paths.append(key)
                self.assertEqual(key.stat().st_mode & 0o777, 0o600)
                self.assertEqual(key.read_bytes(), private_key)
                sid = argv[3]
                return subprocess.CompletedProcess(argv, 0, json.dumps({
                    "id": sid, "name": monitor.TARGETS[sid], "status": "In Progress",
                }), "")

            environment = {
                "RUNNER_TEMP": temporary,
                "SECRET_APPLE_API_KEY_P8_BASE64": base64.b64encode(private_key).decode(),
                "SECRET_APPLE_API_KEY_ID": "key-id",
                "SECRET_APPLE_API_ISSUER": "issuer",
                "NOTARY_TELEGRAM_BOT_TOKEN": "private-token",
                "NOTARY_TELEGRAM_CHAT_ID": "123456",
            }
            output = io.StringIO()
            with mock.patch.dict(monitor.os.environ, environment), mock.patch.object(
                monitor.subprocess, "run", side_effect=external_query,
            ), mock.patch.object(monitor, "telegram_request", side_effect=AssertionError("must not notify")), contextlib.redirect_stdout(output):
                self.assertEqual(monitor.main(["--state", str(pathlib.Path(temporary) / "state.json")]), 0)
            self.assertEqual(len(key_paths), 2)
            self.assertTrue(all(not key.exists() for key in key_paths))
            self.assertNotIn("private-token", output.getvalue())
            self.assertNotIn("fixture", output.getvalue())

    def test_persisted_binding_cannot_mix_v063_or_different_submission_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "state.json"
            state = monitor.new_state()
            monitor.save_state(path, state)
            self.assertEqual(monitor.load_state(path), state)
            state["version"] = "0.6.3"
            monitor.save_state(path, state)
            with self.assertRaisesRegex(monitor.SafeFailure, "StateInvalid"):
                monitor.load_state(path)


if __name__ == "__main__":
    unittest.main()
