---
name: ride-gmail-receipts
description: Export Grab and Gojek ride receipts from Gmail using gog and render them to claim-ready PDFs. Use when the user asks to find, export, download, or prepare Grab or Gojek ride receipts from Gmail for claims.
---

# Ride Gmail Receipt Export

Export Grab and Gojek ride receipts from `yjsoon@gmail.com` without browser automation. This skill uses `gog` to read Gmail, decodes the receipt HTML, and renders a clean PDF with Playwright.

## Prerequisites

- Run from `tools/claim-manager`.
- `gog` is installed and authenticated for `yjsoon@gmail.com`.
- `scripts/` dependencies are installed with `npm install`.
- Do not send mail from this skill.
- Use the Gmail label `exported` as the receipt export cursor. Add the label only after a PDF has rendered successfully, and only when the user wants the export state updated.

## Standard Commands

```bash
cd scripts
npm run export:grab -- --since-last-exported --label-exported --max 20
npm run export:gojek -- --since-last-exported --label-exported --max 20
```

The shared command is also available:

```bash
cd scripts
npm run export:ride -- --provider grab
npm run export:ride -- --provider gojek
```

PDFs go to `~/Downloads` by default:

```text
grab_YYYY-MM-DD_AMOUNT.pdf
gojek_YYYY-MM-DD_AMOUNT.pdf
```

The script prints JSON with `provider`, `threadId`, `messageId`, the provider receipt ID, `date`, `amount`, and `pdfPath`.

## Export Cursor

For repeat runs, start from the newest provider receipt already labelled `exported`, then export newer unlabelled receipts. The script does this with:

```bash
cd scripts
npm run export:ride -- --provider grab --since-last-exported
npm run export:ride -- --provider gojek --since-last-exported
```

When the exported PDF is accepted for the claim workflow, mark that Gmail thread so the next run starts after it:

```bash
cd scripts
npm run export:ride -- --provider grab --since-last-exported --label-exported
npm run export:ride -- --provider gojek --since-last-exported --label-exported
```

The exporter searches `label:exported` for the selected provider, uses the latest matching receipt message timestamp as the cutoff, searches `-label:exported`, and skips messages at or before the cutoff.

If there is nothing newer than the latest labelled receipt, the script exits successfully and prints JSON with `status: "no_new_receipts"`.

## Export A Specific Thread

Use this when a Gmail thread ID is already known:

```bash
cd scripts
npm run export:grab -- --thread <gmail-thread-id>
npm run export:gojek -- --thread <gmail-thread-id>
```

To control the output path:

```bash
cd scripts
npm run export:ride -- --provider gojek --thread <gmail-thread-id> --out ~/Downloads/gojek_2026-06-04_21.30.pdf
```

## Provider Details

- Grab search phrase: `from:grab subject:"Your Grab E-Receipt"`
- Gojek search phrase: `"Your trip with Gojek"`
- Export cursor label: `exported`
- Grab validation fields: `Booking ID`, `Picked up on`, `Total Paid`
- Grab exclusions: ignore GrabFood / Grab Food receipts unless the user explicitly asks for food claims.
- Gojek validation fields: `Order ID`, `Thanks for ordering Gojek`, `Total paid S$`

## Verification

After export:

1. Check that the command JSON includes a non-`unknown` receipt ID, date, and amount.
2. Confirm the PDF exists and is larger than 10 KB.
3. If exact text verification is needed, extract text with a local PDF tool and check for the provider validation fields above.
4. If JSON returns `status: "no_new_receipts"`, no PDF is expected.

## Notes

- The script intentionally targets ride receipts only.
- GrabFood / Grab Food receipts and GrabPay wallet statements should not be exported through this skill unless the user broadens the request.
- Keep generated PDFs out of git. Use them for the receipt uploader or Volopay claim flow.
