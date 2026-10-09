# Bookings

_Rent out boats, rooms, equipment or time without double-booking._

Booking is built from the same pieces as everything else, plus one shape to learn: **two entities, not one.**

> The thing being booked and the request to book it are separate shapes. A boat has a name and an hourly rate. A request has a customer, a start and an end. One entity can't be both, because ten boats and forty requests aren't the same list.

There is no third entity for customers. The record a submission creates **is** the customer: it is where their name and email already are, and the resulting order points back at it.

## Set up

### 1. Make the resource entity

One entity for the things you rent out, one record per thing. Ten boats means ten records. Give it a **text field** for the name and a **number field** for the price in whole currency units (150 means 150.00). Call them whatever you like; you point the booking form at them later.

### 2. Make the request entity

A separate entity for what the customer tells you: name, email, phone, start, end. Each submission becomes one record here.

### 3. Make each resource bookable

Open a resource record and **start bookings** on it. This gives it **capacity** that can run out. Choose how it is counted:

| Strategy | Use for |
|---|---|
| Individual asset | One uniquely identified unit: "Boat #4", a vehicle, a room |
| Pooled quantity | Stock of identical items: 50 kayaks, 30 tents |
| Time slot | Concurrent capacity over time: consulting hours, a tour guide |

You can also set a **buffer**: minutes of turnaround blocked after each booking, such as 30 minutes of cleaning.

### 4. Build the booking form

Create a form on the **request** entity, not the resource entity. Its catalogue lists the resource entity so the visitor picks which boat. In its booking settings, match up the start, end (or duration) and quantity fields, how the price is counted, and the resource's rate and name fields.

## What happens when someone books

1. The visitor picks a resource and a time.
2. Graft checks availability, including buffers and everything already held.
3. It places a **hold** on the capacity so nobody else can take it while the order is processed.
4. It creates a **draft order**, priced from the resource's rate and duration, with your deposit rule applied.
5. The order appears in **Operations**, and you confirm it, optionally taking a deposit.

Times are treated as up to but not including the end, so a 10:00 to 12:00 booking leaves 12:00 free for the next one.

## Things that cannot change later

- A field's **key** is permanent once saved. Rename its label freely.
- How a resource is **counted** is fixed when you start bookings on it. Changing it means stopping bookings and starting again, which keeps past bookings readable but frees the resource.

## Troubleshooting

**The request was saved but nothing was reserved.** The resource has no capacity set because nobody started bookings on that record. The submission and order are kept, since the customer did nothing wrong, but nothing stopped a second person taking the same slot. Start bookings on the record.

**A booking was refused as unavailable.** Something already holds that resource for part of that window: a confirmed booking, a pending request, or the buffer either side of one.
