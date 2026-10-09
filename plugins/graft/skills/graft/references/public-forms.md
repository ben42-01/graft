# Public forms

_Submit a published form and read its catalogue without an account._

A published public form lives at `/f/{tenantSlug}/{formSlug}`. Its API twin needs no authentication, which makes it the only unauthenticated write surface in Graft and the most heavily guarded.

## Submit

```bash
curl -s -X POST "$GRAFT/api/v1/public/forms/bellas-barbershop/book-a-cut/submissions" \
  -H 'content-type: application/json' \
  -d '{
    "data": { "customer": "Ada King", "email": "ada@example.com" },
    "_t": 1790000000000
  }'
```

| Field | Meaning |
|---|---|
| `data` | The form's field values, validated against the entity's schema. Unknown fields are rejected. |
| `_t` | When the page was rendered, in milliseconds since epoch. A submission that arrives implausibly fast is treated as spam. |
| `_hp` | Honeypot. Leave it out or empty. A filled honeypot is treated as spam. |
| `_selection` | On a catalogue form: the id of the one record the visitor chose. |
| `_cart` | On a cart form: 1 to 20 lines of `{ "recordId": "…", "quantity": 2 }`. |

A spam submission gets the same `201` as a real one, so a bot can't tell. Spam doesn't count toward the monthly limit; accepted submissions do. Using the wrong one of `_selection` and `_cart` for the form is a `400`.

### Cart rules

- Each `recordId` must be a live record of the form's catalogue, and may appear once.
- Quantity is a whole number from 1 to 100,000.
- Lines are strict: a line carrying `price`, `amount` or any other key is rejected. **The client never sends a price.** Each line is priced from its record and snapshotted.
- One cart creates one draft order with a line per item.
- If any line exceeds remaining capacity the whole submission is `409 CONFLICT` and nothing is written.

### Payment

A successful submit returns `submissionId`. If the form takes payment, the response also carries `payment: { url, required }`, the Stripe Payment Link or Checkout URL to send the visitor to, and `required` says whether payment is compulsory. A form in manual payment mode returns `paymentInstructions` instead, the owner's own words to show on the thank-you page. Both keys are absent on a form that takes no money.

## Browse a catalogue

```
GET /api/v1/public/forms/{tenantSlug}/{formSlug}/catalogue?limit=12
```

Returns one page of the records the form invites visitors to browse. Only the fields the form owner chose to show are returned; everything else on the record stays private. Page size is capped at 24.

## Errors you may see

| Status | When |
|---|---|
| `400 VALIDATION_FAILED` | Invalid or unknown fields, bad `_selection` or `_cart` |
| `404 NOT_FOUND` | No such form, it is unpublished, or it has been switched off |
| `403 QUOTA_EXCEEDED` | The workspace has used its submissions for the month |
| `409 CONFLICT` | A booked resource has no capacity left for that window |
| `429 RATE_LIMITED` | More than 10 submissions a minute from one IP to one form |
