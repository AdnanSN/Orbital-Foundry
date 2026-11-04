import { parseStationMap, type StationMap } from "./map";
import rawMap from "./station.map.json" with { type: "json" };

export * from "./crew";
export * from "./events";
export * from "./geometry";
export * from "./layout";
export * from "./map";
export * from "./pathfinding";

let cached: StationMap | undefined;

/** The station map from station.map.json, validated on first use. */
export function getStationMap(): StationMap {
  cached ??= parseStationMap(rawMap);
  return cached;
}
