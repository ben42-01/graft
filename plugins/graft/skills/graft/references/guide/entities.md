# Entities

_Define your own data objects and fields._

An entity is a **kind of thing you track**: customers, jobs, bookings, products. It describes the shape; [records](../records/) are the data.

## Creating an entity

Go to **Entities** and create one, from scratch or from an [entity template](../templates/#entity-templates). Give it:

- a **name**, such as "Customers"
- a **key**, the permanent identifier (lowercase letters, digits and underscores, starting with a letter)
- one or more **fields**, up to 100

Most workspaces need two or three entities, not twenty.

## Field types

| Type | Holds |
|---|---|
| Text | Free text |
| Number | A number. For money, use whole currency units (150 means 150.00) |
| Date | A date and time |
| Choice list | One of a list of options you provide (at least one) |
| Yes / no | A checkbox |
| Email | An email address |
| Phone | A phone number |
| Image | A picture of the thing (a product photo, a room). Uploaded after the record exists, so it can never be required |

Each field has a **label** (shown to people), a **key** (used in data and the API), and a **required** flag. Number fields can have a minimum and maximum.

## Changing an entity

You can rename it and add, remove or relabel fields under **Fields & settings**.

> **Caution:** A field's **key is permanent** once saved, because your records are stored under it. You can rename the label freely. To "change" a key, add a new field. Removing a field leaves data already stored under that key unreachable, and the editor warns you before saving.
## Limits

Free allows 3 entities, Premium 25, Enterprise unlimited. See [Plans and limits](../plans/).

## Entity design tips

- **One entity per shape.** Ten boats and forty booking requests are different lists. Booking needs two entities; see [Bookings](../bookings/).
- **Start small.** You can add fields later but can't reuse a key.
- **Use a choice list** for anything with a fixed set of answers, like status.
