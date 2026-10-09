# Forms

_Build internal and public forms, share them and add catalogues, bookings, payment and notices._

A form is a named, ordered subset of **one entity's fields**. A form can only collect fields its entity already has. Every submission becomes a record in that entity.

## Internal and public

| | Internal | Public |
|---|---|---|
| Who fills it in | You and your team | Anyone with the link, no account |
| Goes live | Immediately | When you **publish** |
| Address | In the app | `/f/<workspace-slug>/<form-slug>` |
| Counts against | Internal forms limit, when created | Active forms limit, when published |

The **slug** is the last part of the address: lowercase letters, digits and single dashes.

## Building a form

1. Go to **Forms** and create one. Pick the **entity** it writes to and tick the **fields** to ask for.
2. Choose its **visibility** and a name and slug.
3. Optionally add the extras below.
4. Publish a public form when you are ready.

Only an **owner or manager** can create, change, publish or delete forms. A member can read them.

## Publishing, unpublishing and the kill switch

- **Publish** makes a public form reachable. **Unpublish** takes it down, and its images go dark with it.
- The **kill switch** (`enabled`) switches a form off instantly and outranks "published": a switched-off form is never served, even if still marked published.
- Drafting a public form is free; only published forms count against your active forms limit.

## Extras you can add

### Image

A form carries one **carousel image** shown at the top of the public page.

### Notices and links

**Content blocks** add text or links between fields. A *notice* shows a message customers should read. A *link* points to a web page, such as your terms, and can **require agreement**, so the customer must tick that they accepted it before submitting.

### Catalogue

Turn a form into a front for your own records. The visitor browses records of another entity and picks one, for example a boat, a product or a room.

- You choose which fields appear on each card (up to six) and which image to show. **Only the fields you list are public.** Anything you don't list stays private, even fields added to the entity later.
- A catalogue form writes to one entity (the request) and browses another (the items). The chosen item is stored on the submission.

### Booking

Booking mode turns a submission into an **order against real capacity**. You say which of the form's fields mean *start*, *end* (or a fixed duration), and *quantity*, how the price is counted (per hour, per day or a flat price), and which fields on the item hold its rate and name. See [Bookings](../bookings/).

### Cart

On a catalogue form with booking mode, you can let visitors **pick several items** with a quantity each. One submission creates one order with a line per item. Prices always come from your records, never from the visitor's browser. Cart forms can't use a fixed payment link, because a cart total isn't fixed.

### Payment

Choose how a customer pays. See [Payments](../payments/).

## Spam protection

Public forms use a hidden honeypot field and a minimum-fill-time check. Spam is silently discarded and doesn't count towards your submissions. Each IP can submit 10 times a minute to one form.

## Limits by plan

| | Free | Premium | Enterprise |
|---|---|---|---|
| Public forms live | 2 | 20 | Unlimited |
| Internal forms | 3 | Unlimited | Unlimited |
| Submissions per month | 100 | 5,000 | Unlimited (fair use) |

When you reach the monthly submission limit, further submissions are refused until the period resets. Counters reset on your billing anniversary.
