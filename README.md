# ScaleaStay calculator

Private calendar for direct bookings. The existing Firebase email/password sign-in and `scalea_app_data` location are retained. No production data or rules are changed by preparing or previewing this source.

## Direct prices for 2027

EUR per paid night, whole apartment, up to four guests. January–December:

`60, 60, 60, 60, 70, 85, 110, 140, 95, 65, 60, 60`

Cleaning and electricity are included in the guest price. There are no OTA schedules or commissions in the calculator. Monthly winter offers remain separate. No minimum stay beyond valid arrival/departure dates is imposed.

Each automatic quote uses the rate for every paid night, with checkout excluded. Automatic rates apply only to nights in 2027; other dates require a manual nightly price. New bookings store an exact total in cents and a nightly breakdown. Historical records keep all their original fields and their former displayed total; changing the default schedule does not recalculate them. For records without saved nightly rates, statistics allocate that preserved total over the stay in integer cents, with any remainder assigned to the first nights. This keeps monthly and yearly statistics consistent with the booking card without rewriting old records. Legacy `prices` data is preserved and is not used as the 2027 schedule.

## Sign-in and recovery

The sign-in screen includes a password-recovery button. The owner enters their account email and explicitly requests an instruction email; the old password is not required. The existing Firebase Auth service and its configured email action handler are retained. Unknown or disabled addresses receive the same neutral confirmation. The owner completes the password change themselves using the link in the email, then returns to sign in. Recovery does not read or change bookings. The isolated preview uses an Auth substitute and sends no email.

## Shared saving

All writes are intentions applied with a Firebase root transaction to its latest value: add one booking, update one advance payment, delete one expected record, or merge an import. Every retry rechecks dates and IDs. No write sends the phone's whole stale state. Transactions use `applyLocally=false`; forms clear only after the server confirms commitment. The live subscription owns the displayed state, so a late transaction result cannot replace a newer listener snapshot.

Editing is disabled before successful loading, after a read failure, while saving, and without a connection. If connectivity drops during a transaction, the screen retains a pending message and the form until confirmation. Unconfirmed browser writes are not a durable offline backup: do not close a pending page.

Imports validate the entire file and merge bookings by ID. Conflicting IDs or dates abort the import; identical records are skipped. Imports never replace the database or tariff settings. Deletion markers prevent a previous export from silently resurrecting deleted records. Exports retain all root and booking fields, plus export metadata, and identify whether the current view was connected.

## Mobile booking workflow

Four screens share the same navigation on phones and desktop: calendar, bookings, add, and more. The booking list searches guest names and phone numbers; filters upcoming stays, missing advances, outstanding balances, fully paid stays, unknown payments and inquiry source; and sorts by arrival, outstanding amount, total or guest. Unknown balances sort after known amounts and never count as debt. The calendar shows the next arrival, departure and preparation task. Form controls and layout support 320px and 390px phone widths without wide tables.

Optional booking details include one to four guests, arrival/departure times, cleaning status, notes and inquiry source (website, social, referral or repeat). Missing historical fields stay missing until the owner explicitly saves an edit. No default arrival time, fee, advance percentage or payment deadline is introduced.

The existing booking card opens a reusable editing form. Date edits retain the agreed total. A separate button explicitly applies the 2027 tariff schedule, or the owner can enter an agreed total. Manual totals are allocated over the stay nights in exact cents for monthly statistics. An existing stay may have an agreed total of zero for complimentary accommodation: its dates remain occupied, the card says «Без оплаты», and it contributes no accommodation value or debt. New nightly prices and recorded payment amounts remain positive; a zero total cannot hide money already received or a received advance with an unknown amount. An edit changes the latest record only when its expected nonfinancial details still match; current advance and payment entries are preserved independently. Date overlaps and accepted money are rechecked on every transaction retry.

## Payments (advance label: «Залог»)

The owner confirmed that this payment counts toward the agreed accommodation total. Each booking can record `advancePayment` with status `unknown`, `not_received`, or `received`, an optional exact amount in cents, and an optional receipt date. No amount, percentage or deadline is imposed. A received payment may have an unknown amount; its remaining balance then stays unknown. Missing metadata in historical records is shown as «Не отмечено», never as an unpaid debt. Loading a historical record does not create metadata or write to the server.

New bookings can include the advance. Existing booking cards allow updating only this field, keeping the original dates, price, total, nightly quote and all other metadata. A transaction compares the field seen when opening the card with the current server field; differing edits from two stale phones require reopening the card. Identical retried updates are harmless. The editor keeps entered values after a rejected write and displays confirmation only after acknowledgment.

Later payments are separate entries with a stable ID, exact amount, optional receipt date and note. The advance is counted once, together with these entries. The card shows received total, remaining amount and full-payment status. Once a stay is fully paid, a separate missing-advance warning is hidden in its card, booking list and calendar, and it is excluded from the missing-advance filter. The original advance status and payment entries are preserved; the warning returns if the balance becomes outstanding again. If the advance status or received amount is unknown, the owner must clarify it before adding later payments; missing information is never assumed to be zero. Received payments cannot exceed the agreed accommodation total. Refunds and expenses are not tracked.

Adding entries merges independent IDs against the latest server record. An unchanged failed form reuses the same payment ID on retry, preventing duplicate receipts. Removing an erroneous payment affects only that entry and leaves a tombstone, so a delayed retry cannot restore it. Live updates refresh the read-only card and ledger while retaining an entered advance or payment draft. Fields clear only after acknowledgment.

Monthly/yearly booking totals remain the booked accommodation value allocated by stay nights; they are not cash received or profit. Payment statistics cover bookings whose arrival is in the selected month. Known recorded receipts and known remaining balances are shown separately, with a count of bookings whose payment is unknown. Unknown remaining amounts are excluded rather than invented.

## Refreshing the installed calculator

The «Ещё» screen includes a visible «Обновить» button. It replaces the current same-origin URL with a single fresh `_refresh` query value, fetching the current HTML and its versioned assets inside the same installed web app. It preserves the existing path, other query parameters, hash, browser storage and authentication. No booking data is written.

Refreshing is blocked while a server write is pending or the calendar is disconnected. Unsaved booking fields, an advance draft or payment fields require confirmation before being discarded. A canceled confirmation retains the draft; a navigation error leaves the button available to retry.

## Check and preview

Requires Node.js 22 or later for the tests, and Python 3 for the local preview:

```sh
node --test tests/*.test.cjs
python3 tools/preview_server.py
```

Open `http://127.0.0.1:8765/preview.html` on the computer running the preview server. The preview uses five synthetic 2027 records, a separate versioned localStorage key and Web Locks. Two windows of the same browser share this demo calendar. The preview entry has no Firebase SDK or Firebase configuration; the preview server blocks network connections and does not serve the production entry. Demonstration storage is separate from the production database.

The automated tests execute the real application and data helpers against an isolated Firebase transaction model, including retries, rejected writes, connectivity changes and two clients. They do not exercise the real Firebase SDK, deployed security rules or phones.

## Before production rollout

Review the preview first. Then coordinate updating/reloading **both** installed phone versions before either person edits bookings. A still-open old version uses a whole-object `set()` and can overwrite data, even after a transaction from the new version. This cannot be prevented by updating only one client's code. The change does not modify server rules or isolate the old client into another database.

After the separately approved publication, verify sign-in, read/write permissions and synchronization using the two updated phones. Preserve available exports before a future recovery operation; never use a production import merely as a test.
