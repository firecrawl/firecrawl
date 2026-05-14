import { Ticker } from "@/components/shared/pixi/Pixi";
import setTimeoutOnVisible from "@/utils/set-timeout-on-visible";

import cell from "./cell";
import cellReveal from "./cellReveal";

const CELL_GRID = [
  "-ooooooooooo-",
  "-oo-------oo-",
  "ooo-------ooo",
  "-oo-------oo-",
  "-oo-------oo-",
];

const REVEAL_ANIMATION_GRID = [
  [
    "---ooooooo---",
    "--o-------o--",
    "--o-------o--",
    "--o-------o--",
    "--o-------o--",
  ],
  [
    "--o-------o--",
    "-o---------o-",
    "-o---------o-",
    "-o---------o-",
    "-o---------o-",
  ],
  [
    "-o---------o-",
    "-------------",
    "o-----------o",
    "-------------",
    "-------------",
  ],
  [
    "-------------",
    "-------------",
    "o-----------o",
    "-------------",
    "-------------",
  ],
];

const features: Ticker = (params) => {
  const cells: ReturnType<typeof cell>[] = [];
  const cellReveals: {
    cell: ReturnType<typeof cellReveal>;
    row: number;
    column: number;
  }[] = [];

  for (let i = 0; i < CELL_GRID.length; i++) {
    const row = CELL_GRID[i];

    for (let j = 0; j < row.length; j++) {
      if (row[j] === "o") {
        cells.push(
          cell({
            ...params,
            x: j * 101,
            y: i * 101,
          }),
        );

        cellReveals.push({
          cell: cellReveal({
            ...params,
            x: j * 101,
            y: i * 101,
          }),
          row: i,
          column: j,
        });
      }
    }
  }

  const cycle = () =>
    setTimeoutOnVisible({
      element: params.canvas,
      callback: () => {
        const cell = cells[Math.floor(Math.random() * cells.length)];

        if (cell) {
          cell.trigger().then(() => cycle());
        }
      },
      timeout: 3000 * Math.random(),
    });

  for (let i = 0; i < 5; i++) {
    cycle();
  }

  let revealIndex = -1;

  const revealCycle = () => {
    revealIndex += 1;

    for (let i = 0; i < REVEAL_ANIMATION_GRID[revealIndex].length; i++) {
      const row = REVEAL_ANIMATION_GRID[revealIndex][i];

      for (let j = 0; j < row.length; j++) {
        if (row[j] === "o") {
          cellReveals
            .find((cell) => cell.row === i && cell.column === j)
            ?.cell.trigger();
        }
      }
    }

    if (revealIndex < REVEAL_ANIMATION_GRID.length - 1) {
      setTimeout(() => {
        revealCycle();
      }, 150);
    }
  };

  revealCycle();
};

export default features;
