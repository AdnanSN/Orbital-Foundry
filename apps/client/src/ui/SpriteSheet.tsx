import { STARTING_CREW } from "@orbital/shared";
import { useEffect, useState } from "react";
import { type Anim, FRAME_COUNT } from "../art/crew";
import { Portrait } from "./Portrait";

/** ?view=sprites: every crew sprite and animation, enlarged, for checking the pixel art. */
export function SpriteSheet() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 140);
    return () => window.clearInterval(id);
  }, []);
  const params = new URLSearchParams(window.location.search);
  const scale = Math.max(1, Math.min(12, Number(params.get("scale") ?? 4)));
  const only = params.get("crew");
  const anims: Anim[] = ["idle", "walk", "type", "carry", "hold"];
  return (
    <div className="pointer-events-auto absolute inset-0 overflow-auto p-6 bg-[#0b0c1a]">
      <h1 className="text-gold font-bold tracking-widest mb-4">CREW SPRITES</h1>
      <table className="border-separate border-spacing-x-3 border-spacing-y-2">
        <thead>
          <tr className="text-dim text-[11px]">
            <th className="text-left">Crew</th>
            {(["down", "left", "right", "up"] as const).flatMap((f) =>
              anims.map((a) => (
                <th key={`${f}-${a}`} className="font-normal">
                  {f}
                  <br />
                  {a}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {STARTING_CREW.filter((c) => !only || only.split(",").includes(c.id)).map((c) => (
            <tr key={c.id}>
              <td className="text-ink font-bold pr-2">{c.name}</td>
              {(["down", "left", "right", "up"] as const).flatMap((facing) =>
                anims.map((anim) => (
                  <td key={`${facing}-${anim}`} className="bg-[#2a2f3a] rounded">
                    <Portrait
                      look={c.look}
                      scale={scale}
                      facing={facing}
                      anim={anim}
                      index={tick % FRAME_COUNT[anim]}
                      {...(anim === "carry" ? { item: "crate" as const } : {})}
                      {...(anim === "hold" ? { item: "cup" as const } : {})}
                    />
                  </td>
                )),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
