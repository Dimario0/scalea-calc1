# ScaleaStay calculator

Private calendar for direct bookings. The existing Firebase email/password sign-in and `scalea_app_data` location are retained. No production data or rules are changed by preparing or previewing this source.

## Direct prices for 2027

EUR per paid night, whole apartment, up to four guests. January–December:

`60, 60, 60, 60, 70, 85, 110, 140, 95, 65, 60, 60`

Cleaning and electricity are included in the guest price. There are no OTA schedules or commissions in the calculator. Monthly winter offers remain separate. No minimum stay beyond valid arrival/departure dates is imposed.

Each automatic quote uses the rate for every paid night, with checkout excluded. Automatic rates apply only to nights in 2027; other dates require a manual nightly price. New bookings store an exact total in cents and a nightly breakdown. Historical records keep all their original fields and their former displayed total; changing the default schedule does not recalculate them. Legacy `prices` data is preserved and is not used as the 2027 schedule.

## Shared saving

All writes are intentions applied with a Firebase root transaction to its latest value: add one booking, update one advance payment, delete one expected record, or merge an import. Every retry rechecks dates and IDs. No write sends the phone's whole stale state. Transactions use `applyLocally=false`; forms clear only after the server confirms commitment. The live subscription owns the displayed state, so a late transaction result cannot replace a newer listener snapshot.

Editing is disabled before successful loading, after a read failure, while saving, and without a connection. If connectivity drops during a transaction, the screen retains a pending message and the form until confirmation. Unconfirmed browser writes are not a durable offline backup: do not close a pending page.

Imports validate the entire file and merge bookings by ID. Conflicting IDs or dates abort the import; identical records are skipped. Imports never replace the database or tariff settings. Deletion markers prevent a previous export from silently resurrecting deleted records. Exports retain all root and booking fields, plus export metadata, and identify whether the current view was connected.

## Advance payment (guest-facing label: «Залог»)

The owner confirmed that this payment counts toward the agreed accommodation total. Each booking can record `advancePayment` with status `unknown`, `not_received`, or `received`, an optional exact amount in cents, and an optional receipt date. No amount, percentage or deadline is imposed. A received payment may have an unknown amount; its remaining balance then stays unknown. Missing metadata in historical records is shown as «Не отмечено», never as an unpaid debt. Loading a historical record does not create metadata or write to the server.

New bookings can include the advance. Existing booking cards allow updating only this field, keeping the original dates, price, total, nightly quote and all other metadata. A transaction compares the field seen when opening the card with the current server field; differing edits from two stale phones require reopening the card. Identical retried updates are harmless. The editor keeps entered values after a rejected write and displays confirmation only after acknowledgment.

«Остаток после залога» subtracts the known advance once from the accommodation total. This feature does not track later final payments or refunds. Monthly/yearly totals remain the booked accommodation value allocated by stay nights; they are not cash received or profit.

## Check and preview

Requires Node.js 22 or later for the tests, and Python 3 for the local preview:

```sh
node --test tests/*.test.cjs
python3 tools/preview_server.py
```

Open `http://127.0.0.1:8765/preview.html`. The preview uses synthetic records, localStorage and Web Locks. Two windows of the same browser share this demo calendar. The preview entry has no Firebase SDK or Firebase configuration; the preview server blocks network connections and does not serve the production entry. Demonstration storage is separate from the production database.

The automated tests execute the real application and data helpers against an isolated Firebase transaction model, including retries, rejected writes, connectivity changes and two clients. They do not exercise the real Firebase SDK, deployed security rules or phones.

## Before production rollout

Review the preview first. Then coordinate updating/reloading **both** installed phone versions before either person edits bookings. A still-open old version uses a whole-object `set()` and can overwrite data, even after a transaction from the new version. This cannot be prevented by updating only one client's code. The change does not modify server rules or isolate the old client into another database.

After the separately approved publication, verify sign-in, read/write permissions and synchronization using the two updated phones. Preserve available exports before a future recovery operation; never use a production import merely as a test.
