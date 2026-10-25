// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator } from "../../application/ports.ts";

export const systemClock: Clock = { now: () => new Date() };

export const cryptoIds: IdGenerator = { newId: () => randomUUID() };
