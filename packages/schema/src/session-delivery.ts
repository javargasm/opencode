export * as SessionDelivery from "./session-delivery"

import { Schema } from "effect"

export const Delivery = Schema.Literals(["steer", "queue", "legacy"])
export type Delivery = typeof Delivery.Type

export const V2Delivery = Schema.Literals(["steer", "queue"])
export type V2Delivery = typeof V2Delivery.Type
