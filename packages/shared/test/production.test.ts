import { getStationMap, STARTING_CREW, type StationEvent } from "@orbital/shared";
import { describe, expect, it } from "vitest";
import { StationSim } from "../src/sim";

const map = getStationMap();
const MINUTE = 60_000;

/** Production (D-046): the crew invent no work, and a restored save loses the invented tasks. */
describe("StationSim without ambient work", () => {
  it("invents no tasks and nudges nobody", () => {
    const sim = new StationSim(map, STARTING_CREW, { seed: 3, ambientWork: false });
    const events: StationEvent[] = [];
    for (let t = 250; t <= 15 * MINUTE; t += 250) events.push(...sim.advanceTo(t));
    expect(sim.taskList).toEqual([]);
    expect(events.some((e) => e.type === "task.updated")).toBe(false);
    expect(events.some((e) => e.type === "agent.activity" && e.activity === "nudge")).toBe(false);
    // The crew still live on the station: they move about off duty.
    expect(events.some((e) => e.type === "agent.moved")).toBe(true);
  });

  it("drops invented tasks when a save is restored for production", () => {
    const ambient = new StationSim(map, STARTING_CREW, { seed: 5 });
    for (let t = 250; t <= 5 * MINUTE; t += 250) ambient.advanceTo(t);
    const save = ambient.save();
    expect(save.tasks.length).toBeGreaterThan(0);

    const prod = StationSim.restore(map, save, { ambientWork: false });
    expect(prod.taskList).toEqual([]);
    for (let t = save.t + 250; t <= save.t + 5 * MINUTE; t += 250) prod.advanceTo(t);
    expect(prod.taskList).toEqual([]);
  });
});
