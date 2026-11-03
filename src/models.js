// Plain data shared by the page and the build. Keep this free of browser and
// three.js imports so vite.config.js can load it too.
//
// A model can set its own turntable with two optional fields:
//   turnDuration  seconds per full turn
//   audio         the loop that plays at that spin
// The loop plays as recorded at the turnDuration, so it stays in time with the
// model when its length is a whole number of turns. At 120 BPM and 2 s a turn,
// one turn is a bar.
export const DEFAULT_TURN_DURATION = 2;
export const DEFAULT_AUDIO = "./assets/audio/Strata_Beat (120 BPM).wav";

export const MODELS = [
  {
    name: "Horse",
    id: "horse",
    url: "./assets/models/horse.glb",
    backgroundColor: "#760DD9",
    audio: "./assets/audio/Strata_Horse (120 BPM).wav"
  },
  {
    name: "Handshake",
    id: "handshake",
    url: "./assets/models/handshake.glb",
    backgroundColor: "#0d9d36"
  },
  {
    name: "Rotating Head",
    id: "rotatinghead",
    url: "./assets/models/rotating-head.glb",
    backgroundColor: "#9E4210",
    audio: "./assets/audio/Strata_Headturn (120 BPM).wav"
  },
  {
    name: "Dialogue",
    id: "dialogue",
    url: "./assets/models/dialogue.glb",
    backgroundColor: "#506666"
  },
  {
    name: "Bouncing Balls",
    id: "bouncingballs",
    url: "./assets/models/bouncing-balls.glb",
    backgroundColor: "#000000"
  },
  {
    name: "Football",
    id: "football",
    url: "./assets/models/football.glb",
    backgroundColor: "#0d9d36"
  }
];

// Text colour that reads against a background. Mirrors CSS contrast-color():
// WCAG relative luminance with the black/white flip at 0.1791.
export function inkColorFor(hex) {
  const channel = (offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance < 0.1791 ? "white" : "black";
}
