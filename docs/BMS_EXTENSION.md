# Agent Execution Context & Integration Scope

> **IMPORTANT INSTRUCTION FOR BUILDING AGENT:**
> 1. **Preserve Existing Architecture:** Do NOT refactor or rebuild the existing tier-based onboarding, tenant setup, or core Business Entity and Customer Action models. They are already functional.
> 2. **Additive Delta Only:** Treat this document as an additive extension specification. Integrate the new inventory, invoicing, and dashboard components into the existing code patterns.
> 3. **Context Verification:** Inspect the current database schema and codebase first to map foreign keys from the new `InventoryPool` directly to existing `BusinessEntity` primary keys.

---

# Business Management System (BMS) Architecture & Functional Specification

**Version:** 1.1  
**Target Audience:** Autonomous AI Engineer / Developer Agent  
**Purpose:** Implementation specification for extending a customer-action MVP into an operational Business Management System with a generic Inventory & Resource Allocation engine.

---

## 1. Executive Architecture Overview

The system expands our event-driven architecture by connecting existing **Business Entities** to dynamic **Inventory/Resource Pools** and stateful **Customer Action Workflows**.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ CUSTOMER-FACING LAYER │
│ ┌─────────────────────────┐ ┌─────────────────────────┐ ┌──────────────────┐ │
│ │ Shared Action Links │ │ Interactive Web Forms │ │ Hosted Invoice │ │
│ └────────────┬────────────┘ └────────────┬────────────┘ └────────┬─────────┘ │
└───────────────┼───────────────────────────────┼───────────────────────────┼────────────┘
                │ │ │
                ▼ ▼ ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ CORE ENGINE ARCHITECTURE │
│ │
│ ┌────────────────────────┐ ┌───────────────────────────────────┐ │
│ │ CUSTOMER ACTION MODEL │ │ BUSINESS ENTITY MODEL │ │
│ │ (EXISTING BASE) │ │ (EXISTING BASE) │ │
│ │ • Action Workflow Steps│ │ • Entity Schema & Meta-Data │ │
│ │ • Form Submissions │ ────────────────► │ • Dynamic Attributes │ │
│ │ • Status Tracking │ │ • Operational Rules │ │
│ └───────────┬────────────┘ └─────────────────┬─────────────────┘ │
│ │ │ │
│ │ │ │
│ ▼ ▼ │
│ ┌────────────────────────────────────────────────────────────────────────────────┐ │
│ │ GENERIC INVENTORY & RESOURCE ALLOCATION (NEW) │ │
│ │ │ │
│ │ • Multi-Strategy Inventory (Individual Units, Pooled Capacity, Time Slots) │ │
│ │ • Real-Time Concurrency Lock & Availability Matrix │ │
│ │ • Turnaround Buffer Management & Maintenance Schedules │ │
│ └──────────────────────────────────────┬─────────────────────────────────────────┘ │
│ │ │
└──────────────────────────────────────────┼─────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ OPERATIONAL COMMAND DASHBOARD (NEW) │
│ ┌────────────────────────┐ ┌───────────────────────────┐ ┌───────────────────────┐ │
│ │ Real-Time Kanban Board │ │ Master Schedule Timeline │ │ Invoicing & Ledger │ │
│ └────────────────────────┘ └───────────────────────────┘ └───────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘

2. Core Functional Domain Specifications
2.1 Generic Inventory & Resource Allocation Engine
Abstracts asset availability across three strategy types:
| Inventory Strategy | Model Behavior | Use Case Example |
|---|---|---|
| Individual Asset Tracking | Tracks uniquely identified units with serial numbers and maintenance logs. | Specific Boat ("Boat #4"), Vehicle VIN, Room. |
| Pooled Quantity Management | Tracks aggregate capacity minus active allocations within a given time frame. | Kayak stock (50 total), Tents, Equipment. |
| Time-Slot / Capacity Matrix | Tracks maximum concurrent service capacity over time windows. | Consulting hours, Tour guide slots, Studio space. |
Technical Requirements for Inventory Engine:
 * Pessimistic Time-Locking: Lock entity availability during checkout flow (e.g., 10-minute hold) to prevent double-booking.
 * Buffer Time Engine: Configurable cooldown windows per entity (e.g., 30 minutes of maintenance/cleaning between bookings).
 * Overbooking Protection API: Expose is_available(entity_id, time_range, quantity) as the single source of truth.
2.2 Centralized Booking & Order Engine with Invoicing
 * Order State Machine: Transitions: Draft → Pending Payment → Confirmed → In Progress → Completed → Cancelled.
 * Dynamic Invoice Generation: Line-item calculations built from Entity Base Pricing, duration multipliers, and add-ons.
 * Split & Deposit Payments: Support upfront deposits, partial holds, and automated remaining-balance collection.
2.3 Operational Command Dashboard
 * Interactive Kanban Pipeline: Drag-and-drop board updated dynamically by customer action state changes.
 * Master Calendar & Timeline View: Visual multi-resource scheduler displaying availability, buffer blocks, and blackout dates.
 * Daily Operations Dispatch: Actionable overview of daily arrivals, active rentals, unsigned waivers, and pending payments.
3. Data Schema Specifications
3.1 Database Entity Relationship Architecture
┌──────────────────────────┐ ┌──────────────────────────┐
│ BusinessEntity │ │ InventoryPool │
│ (EXISTING MODEL) │ │ (NEW TABLE) │
├──────────────────────────┤ ├──────────────────────────┤
│ id (UUID) │ 1 * │ id (UUID) │
│ tenant_id (FK) ├───────►│ entity_id (FK) │
│ name (String) │ │ strategy_type (Enum) │
│ entity_type (String) │ │ total_quantity (Int) │
│ metadata (JSONB) │ │ buffer_time_minutes(Int) │
└────────────┬─────────────┘ └────────────┬─────────────┘
             │ │
             │ 1 │ 1
             │ │
             │ * │ *
┌────────────▼─────────────┐ ┌────────────▼─────────────┐
│ CustomerAction │ │ ResourceAllocation │
│ (EXISTING MODEL) │ │ (NEW TABLE) │
├──────────────────────────┤ ├──────────────────────────┤
│ id (UUID) │ 1 * │ id (UUID) │
│ entity_id (FK) ├───────►│ inventory_pool_id (FK) │
│ order_id (FK) │ │ action_id (FK) │
│ action_type (String) │ │ start_time (Timestamp) │
│ form_data (JSONB) │ │ end_time (Timestamp) │
│ status (Enum) │ │ allocated_quantity (Int) │
└────────────┬─────────────┘ └──────────────────────────┘
             │
             │ *
             │
┌────────────▼─────────────┐ ┌──────────────────────────┐
│ Order │ │ Invoice │
│ (NEW TABLE) │ │ (NEW TABLE) │
├──────────────────────────┤ ├──────────────────────────┤
│ id (UUID) │ 1 1 │ id (UUID) │
│ customer_id (FK) ├───────►│ order_id (FK) │
│ total_amount (Decimal) │ │ status (Enum) │
│ order_status (Enum) │ │ line_items (JSONB) │
└──────────────────────────┘ └──────────────────────────┘

3.2 Concrete JSON Data Schema Samples
Business Entity Definition Example
{
  "entity_id": "ent_99182312",
  "tenant_id": "biz_alpha_rentals",
  "name": "24ft Pontoon Boat",
  "entity_type": "RENTAL_EQUIPMENT",
  "metadata": {
    "capacity": 10,
    "requires_waiver": true,
    "hourly_rate": 150.00,
    "security_deposit": 300.00
  },
  "inventory_config": {
    "strategy_type": "INDIVIDUAL_ASSET",
    "buffer_time_minutes": 30,
    "auto_lock_on_checkout": true
  }
}

Customer Action Instance Example
{
  "action_id": "act_8823104",
  "entity_id": "ent_99182312",
  "action_type": "BOOKING_REQUEST",
  "status": "AWAITING_PAYMENT",
  "form_data": {
    "customer_name": "Jane Doe",
    "customer_email": "jane@example.com",
    "requested_start": "2026-06-15T10:00:00Z",
    "requested_end": "2026-06-15T14:00:00Z",
    "add_ons": ["life_jackets", "cooler"]
  },
  "created_at": "2026-06-10T08:30:00Z"
}

4. Implementation Roadmap for Building Agent
 * Step 1: Database Migration & Schema Extension
   * Create InventoryPool, ResourceAllocation, Order, and Invoice tables.
   * Add indexes on (entity_id, start_time, end_time) for high-performance availability queries.
 * Step 2: Core Inventory & Reservation Engine
   * Build AvailabilityService to validate available capacity, calculate turnaround buffers, and manage temporary locks.
   * Attach lock triggers to form submissions on existing Customer Action endpoints.
 * Step 3: Invoicing & Payment Integration Layer
   * Implement line-item pricing calculators using BusinessEntity metadata.
   * Add payment hooks to transition Customer Actions to CONFIRMED upon checkout completion.
 * Step 4: Operational Command Dashboard UI
   * Construct real-time Kanban pipeline UI powered by Customer Action state updates.
   * Add resource timeline calendar view showing allocations and availability.
