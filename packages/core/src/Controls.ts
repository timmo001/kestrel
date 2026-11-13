/**
 * What a camera can be told to do, such as pan, tilt and zoom or change its
 * picture's colour, what's sent to it and what it reports back. Directions,
 * zoom and picture settings are shares of the camera's own range, so the
 * page needs none of its numbers.
 *
 * @module
 */
import { Schema } from "effect";

/**
 * Which ways a camera moves, and whether it zooms its lens, has presets,
 * has a home it goes back to and follows what it sees on its own.
 */
export const PtzControls = Schema.Struct({
  pan: Schema.Boolean,
  tilt: Schema.Boolean,
  zoom: Schema.Boolean,
  presets: Schema.Boolean,
  home: Schema.Boolean,
  tracking: Schema.Boolean,
});

export interface PtzControls extends Schema.Schema.Type<typeof PtzControls> {}

/**
 * Which of its picture settings a camera lets you change, and whether it
 * can put them back to its defaults.
 */
export const PictureControls = Schema.Struct({
  hue: Schema.Boolean,
  brightness: Schema.Boolean,
  contrast: Schema.Boolean,
  saturation: Schema.Boolean,
  sharpness: Schema.Boolean,
  reset: Schema.Boolean,
});

export interface PictureControls extends Schema.Schema.Type<
  typeof PictureControls
> {}

/** Each control a camera has; `null` for one it doesn't. */
export const CameraControls = Schema.Struct({
  ptz: Schema.NullOr(PtzControls),
  picture: Schema.NullOr(PictureControls),
});

export interface CameraControls extends Schema.Schema.Type<
  typeof CameraControls
> {}

/** A direction's share of full speed, from -1 to 1. */
const Direction = Schema.Number.check(
  Schema.isBetween({ minimum: -1, maximum: 1 }),
);

/** What a camera can follow on its own. */
export const TrackTarget = Schema.Literals(["people", "vehicles", "animals"]);

export type TrackTarget = typeof TrackTarget.Type;

/**
 * How it follows: zooming in on the picture alone, zooming first and
 * turning once that's not enough, or turning first.
 */
export const TrackMethod = Schema.Literals([
  "digital",
  "digital-first",
  "turn-first",
]);

export type TrackMethod = typeof TrackMethod.Type;

const Seconds = Schema.Int.check(Schema.isGreaterThan(0));

const PresetName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32),
);

/**
 * What a camera is told to do: start moving, with right and down positive,
 * faster the further from 0; stop; zoom its lens to a share of its range,
 * 0 widest; go to a preset; save where it points now as a new preset,
 * rename one or clear one; go home, or make where it points now home;
 * change how it follows what it sees; or change when it goes home.
 */
export const PtzCommand = Schema.TaggedUnion({
  Move: { pan: Direction, tilt: Direction },
  Stop: {},
  Zoom: {
    level: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  },
  Preset: { id: Schema.Int },
  SavePreset: { name: PresetName },
  RenamePreset: { id: Schema.Int, name: PresetName },
  ClearPreset: { id: Schema.Int },
  Home: {},
  SetHome: {},
  Track: {
    on: Schema.optionalKey(Schema.Boolean),
    follows: Schema.optionalKey(Schema.Array(TrackTarget)),
    method: Schema.optionalKey(TrackMethod),
    backAfterLeaving: Schema.optionalKey(Seconds),
    backAfterStopping: Schema.optionalKey(Seconds),
  },
  KeepHome: {
    on: Schema.optionalKey(Schema.Boolean),
    backAfter: Schema.optionalKey(Seconds),
  },
});

export type PtzCommand = typeof PtzCommand.Type;

/** A place a camera has been saved to look at. */
export const PtzPreset = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
});

export interface PtzPreset extends Schema.Schema.Type<typeof PtzPreset> {}

/**
 * How a camera follows what it sees: whether it does, what it follows of
 * what it can, how, of the ways it can, and how many seconds after its
 * subject leaves or stops it goes home, of the choices it takes; `null`
 * where it doesn't say.
 */
export const Tracking = Schema.Struct({
  on: Schema.Boolean,
  follows: Schema.Array(TrackTarget),
  targets: Schema.Array(TrackTarget),
  method: Schema.NullOr(TrackMethod),
  methods: Schema.Array(TrackMethod),
  backAfterLeaving: Schema.NullOr(Schema.Int),
  backAfterStopping: Schema.NullOr(Schema.Int),
  backChoices: Schema.Array(Schema.Int),
});

export interface Tracking extends Schema.Schema.Type<typeof Tracking> {}

/**
 * Its home: whether it goes back there once left alone, whether one's
 * been set, and how many seconds alone before it goes back.
 */
export const PtzHome = Schema.Struct({
  on: Schema.Boolean,
  set: Schema.Boolean,
  backAfter: Schema.Int,
});

export interface PtzHome extends Schema.Schema.Type<typeof PtzHome> {}

/**
 * Where a camera's lens is zoomed now, from 0 to 1, its presets, its home
 * and how it follows what it sees, each `null` where it has none.
 */
export const PtzState = Schema.Struct({
  zoom: Schema.NullOr(Schema.Number),
  presets: Schema.Array(PtzPreset),
  home: Schema.NullOr(PtzHome),
  tracking: Schema.NullOr(Tracking),
});

export interface PtzState extends Schema.Schema.Type<typeof PtzState> {}

/** A picture setting's share of the camera's own range, from 0 to 1. */
const Share = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/** A camera's picture settings now, each `null` where it has none. */
export const PictureState = Schema.Struct({
  hue: Schema.NullOr(Share),
  brightness: Schema.NullOr(Share),
  contrast: Schema.NullOr(Share),
  saturation: Schema.NullOr(Share),
  sharpness: Schema.NullOr(Share),
});

export interface PictureState extends Schema.Schema.Type<typeof PictureState> {}

/**
 * What a camera's picture is told: change some of its settings, leaving
 * the rest, or put them all back to its defaults.
 */
export const PictureCommand = Schema.TaggedUnion({
  Set: {
    hue: Schema.optionalKey(Share),
    brightness: Schema.optionalKey(Share),
    contrast: Schema.optionalKey(Share),
    saturation: Schema.optionalKey(Share),
    sharpness: Schema.optionalKey(Share),
  },
  Reset: {},
});

export type PictureCommand = typeof PictureCommand.Type;
