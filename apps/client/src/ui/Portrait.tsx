import type { CarryItem, CrewLook, Direction } from "@orbital/shared";
import { useEffect, useRef } from "react";
import { type Anim, composeFrame, crewPalette, paintFrame, SPRITE_SIZE } from "../art/crew";

/** A crew sprite frame drawn crisp at an integer scale. */
export function Portrait({
  look,
  scale = 3,
  facing = "down",
  anim = "idle",
  index = 0,
  item,
  className = "",
}: {
  look: CrewLook;
  scale?: number;
  facing?: Direction;
  anim?: Anim;
  index?: number;
  item?: CarryItem;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const spec = item ? { facing, anim, index, item } : { facing, anim, index };
    paintFrame(ctx, composeFrame(look, spec), crewPalette(look), 0, 0, scale);
  }, [look, scale, facing, anim, index, item]);
  const size = SPRITE_SIZE * scale;
  return <canvas ref={ref} width={size} height={size} className={`pixelated ${className}`} />;
}
