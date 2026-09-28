import argparse
import json
import os
import sys
import tempfile


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pst-path", required=True)
    return parser.parse_args()


def normalize_text(value):
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n").strip()


def folder_matches_sent(name):
    lowered = (name or "").strip().lower()
    return "sent" in lowered or "gesendet" in lowered


def find_sent_folder(folder):
    try:
        for subfolder in folder.Folders:
            if folder_matches_sent(subfolder.Name):
                return subfolder
            result = find_sent_folder(subfolder)
            if result is not None:
                return result
    except Exception:
        return None
    return None


def json_result(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def main():
    args = parse_args()
    pst_path = os.path.abspath(args.pst_path)

    if not os.path.exists(pst_path):
        raise FileNotFoundError(f"PST file not found: {pst_path}")

    try:
        import pythoncom
        import win32com.client
    except Exception as error:
        raise RuntimeError(
            "pywin32 is not installed for Python. Run: py -3 -m pip install pywin32"
        ) from error

    pythoncom.CoInitialize()
    outlook = None
    namespace = None
    target_store = None
    target_root = None

    try:
        outlook = win32com.client.Dispatch("Outlook.Application")
        namespace = outlook.GetNamespace("MAPI")

        existing_paths = set()
        for index in range(1, namespace.Stores.Count + 1):
            store = namespace.Stores.Item(index)
            try:
                existing_paths.add(os.path.normcase(store.FilePath or ""))
            except Exception:
                continue

        namespace.AddStore(pst_path)

        normalized_target_path = os.path.normcase(pst_path)
        for index in range(1, namespace.Stores.Count + 1):
            store = namespace.Stores.Item(index)
            store_path = os.path.normcase((store.FilePath or ""))
            if store_path == normalized_target_path or (
                store_path not in existing_paths and store_path
            ):
                target_store = store
                break

        if target_store is None:
            target_store = namespace.Stores.Item(namespace.Stores.Count)

        target_root = target_store.GetRootFolder()
        sent_folder = find_sent_folder(target_root)
        if sent_folder is None:
            raise RuntimeError("Could not find a Sent Items folder inside the selected PST.")

        emails = []
        for item in sent_folder.Items:
            try:
                message_class = normalize_text(getattr(item, "MessageClass", ""))
                if message_class and not message_class.startswith("IPM.Note"):
                    continue

                subject = normalize_text(getattr(item, "Subject", ""))
                body = normalize_text(getattr(item, "Body", ""))
                recipients = normalize_text(getattr(item, "To", ""))
                sender = normalize_text(getattr(item, "SenderName", ""))
                sent_on = getattr(item, "SentOn", None)

                if not subject and not body and not recipients:
                    continue

                email = {
                    "id": f"pst-mail-{len(emails) + 1}",
                    "subject": subject or "(No Subject)",
                    "recipients": recipients or "(No Recipients)",
                    "date": sent_on.isoformat() if sent_on else "",
                    "folderPath": "PST / Sent Items",
                    "sender": sender,
                    "body": body,
                    "textForAnalysis": body,
                }
                emails.append(email)
            except Exception:
                continue

        temp_fd, json_path = tempfile.mkstemp(prefix="toxicradar-pst-", suffix=".json")
        os.close(temp_fd)
        with open(json_path, "w", encoding="utf-8") as file_handle:
            json.dump(emails, file_handle, ensure_ascii=False)

        json_result({
            "success": True,
            "pstPath": pst_path,
            "emailsJsonPath": json_path,
            "count": len(emails),
        })
    finally:
        if namespace is not None and target_root is not None:
            try:
                namespace.RemoveStore(target_root)
            except Exception:
                pass
        pythoncom.CoUninitialize()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(1)
