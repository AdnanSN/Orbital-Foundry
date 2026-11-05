import { useSyncExternalStore } from "react";

/** UI state shared by the Phaser scene and the React panels. */

export type Selection = { kind: "agent"; id: string } | { kind: "room"; id: string } | null;

export interface UiState {
  selection: Selection;
  /** Keep the camera on the selected crew member. */
  follow: boolean;
  showNames: boolean;
  fps: number;
  /** Camera zoom in CSS pixels per station pixel. */
  zoom: number;
  hoverRoom: string | null;
  /** A side panel that replaces the inspector: the Recruitment Bay. */
  panel: "hire" | "work" | "desk" | "gallery" | "stores" | "thumbs" | null;
  /** The gallery's room filter ("" for every room). */
  galleryRoom: string;
  /** A deliverable open in the viewer. */
  viewing: string | null;
  /** A short message at the top of the screen. */
  toast: { id: number; text: string } | null;
}

/** Camera controls the scene registers for the panels' buttons. */
export interface CameraCommands {
  zoomBy(factor: number): void;
  fit(): void;
  /** The opening view, centred on the Command Bridge. */
  home(): void;
  /** The room under a point on the page (CSS pixels), for drag and drop. */
  roomAtClient(clientX: number, clientY: number): string | null;
  focusAgent(id: string): void;
  focusRoom(id: string): void;
}

export class UiStore {
  private state: UiState = {
    selection: null,
    follow: false,
    showNames: true,
    fps: 0,
    zoom: 1,
    hoverRoom: null,
    panel: null,
    galleryRoom: "",
    viewing: null,
    toast: null,
  };
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  camera: CameraCommands | null = null;

  get = (): UiState => this.state;

  set(patch: Partial<UiState>): void {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (this.state[k as keyof UiState] !== v) changed = true;
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  toast(text: string, ms = 4_000): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.set({ toast: { id: Date.now(), text } });
    this.toastTimer = setTimeout(() => this.set({ toast: null }), ms);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useUi<T>(store: UiStore, select: (s: UiState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}
