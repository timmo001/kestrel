/**
 * Times and days as a source keeps them: its own local wall-clock time,
 * with no zone, as a recorder keeps its clock.
 *
 * @module
 */
import { Schema } from "effect";

/** A source's wall-clock time, such as `2026-11-11T22:24:31`. */
export const LocalTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
);

export type LocalTime = typeof LocalTime.Type;

/** A source's calendar day, such as `2026-11-11`. */
export const LocalDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
);

export type LocalDate = typeof LocalDate.Type;

/** A month, such as `2026-11`. */
export const LocalMonth = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}$/),
);

export type LocalMonth = typeof LocalMonth.Type;
