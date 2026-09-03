"""
Enrol, list and revoke passkeys from the owner's own machine.

This is the root of trust and the reason there is no recovery path in the web
client: the only way to authorise a new device is to run a command on the PC
where the data already lives. `enroll` answers "I have a new device";
`credentials` and `revoke` answer the opposite question, which is the same
problem seen from the other side and is why they ship together rather than as
a follow-up.

Invoked through `scripts/api.mjs`, like every other Python entry point in this
repo, so it runs against the API's own interpreter and reads the same `.env`.
"""

import sys
from datetime import datetime

from app.services import auth_store

USAGE = "Usage: node scripts/api.mjs <enroll|credentials|revoke <id>>"


def _local(moment: datetime | None) -> str:
    if moment is None:
        return "never"
    return moment.astimezone().strftime("%Y-%m-%d %H:%M")


def enroll() -> int:
    """
    Prints a code, in two groups of four because eight characters in a row are
    hard to read off a screen and type into a phone.

    The separator is presentation only — `auth_store.normalise_code` drops it,
    along with case and any spaces, so the owner can type it back whichever way
    is easiest.
    """
    code = auth_store.issue_code()
    print(f"\nEnrolment code:  {code[:4]}-{code[4:]}\n")
    print("Valid for 10 minutes, and it enrols one device.")
    print("Open the site on the device you are enrolling, choose 'Enrol a new device',")
    print("and type the code in. Dashes and case do not matter.\n")
    return 0


def credentials() -> int:
    enrolled = auth_store.list_credentials()
    if not enrolled:
        print("\nNo passkeys enrolled. Run `node scripts/api.mjs enroll` to add one.\n")
        return 0

    print(f"\n{'ID':<10}{'LABEL':<24}{'CREATED':<18}LAST USED")
    for credential in enrolled:
        print(
            f"{credential.id:<10}"
            f"{credential.label[:22]:<24}"
            f"{_local(credential.created_at):<18}"
            f"{_local(credential.last_used_at)}"
        )
    print()
    return 0


def revoke(short_id: str) -> int:
    """
    Removes one passkey by the short id `credentials` prints.

    Revoking does not end the sessions that credential already established —
    they are separate records and a lost device may still be holding a live
    token. So this reports what is left to do rather than pretending the
    device is locked out.
    """
    matched = next((c for c in auth_store.list_credentials() if c.id == short_id), None)
    if matched is None or not auth_store.revoke_credential(short_id):
        print(f"\nNo enrolled passkey has the id '{short_id}'.")
        print("Run `node scripts/api.mjs credentials` to see the ones that do.\n")
        return 1

    print(f"\nRevoked {matched.id} ({matched.label or 'unlabelled'}).")
    print("That passkey can no longer sign in. Any session it already created")
    print("stays live until it expires — sign out on that device if you can.\n")
    return 0


def main(argv: list[str]) -> int:
    if not argv:
        print(USAGE)
        return 1

    mode, rest = argv[0], argv[1:]
    if mode == "enroll":
        return enroll()
    if mode == "credentials":
        return credentials()
    if mode == "revoke":
        if len(rest) != 1:
            print("Usage: node scripts/api.mjs revoke <id>")
            return 1
        return revoke(rest[0])

    print(USAGE)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
