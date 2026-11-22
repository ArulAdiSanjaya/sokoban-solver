[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ArulAdiSanjaya/push-optimal-sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ArulAdiSanjaya/push-optimal-sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Push-Optimal Sokoban Solver

A Sokoban solver for make.fun's "Build the best Sokoban solver"
(sokoban-solver-01-run-20261121) bounty. One program, `main.ts`, answers a
whole set of 5 levels in a single run, in as few pushes as possible.

## How it works

A generated level is a hallway with 1–4 rooms off it, 3–4 boxes per room,
and a box pushed out of a room into the hallway can never come back — so
each room is an independent push-optimal problem and the level's optimum is
the sum of its rooms' optima. The solver therefore:

1. splits the level into rooms (cutting the hallway's dead squares out of
   the floor),
2. solves each room with **A\* over pushes** — a state is the boxes plus
   the player's reachable region — using an admissible heuristic (the
   minimum-cost matching of boxes to goals over walking distances) and two
   deadlock prunes that never cut a solvable state: dead squares and frozen
   2×2 blocks of walls and boxes,
3. walks the player between rooms and concatenates the per-room move
   strings.

A\* with an admissible, consistent heuristic returns the push-optimal
solution, so every solved room is solved in exactly its optimum number of
pushes. If A\* exhausts its work budget on a room, greedy best-first
search and then plain BFS over pushes are tried, so a hard room still
yields a valid solution.

Everything is budgeted by work (state expansions), never by the clock: no
clock reads, no randomness, so two runs write byte-identical output. Plain
TypeScript, Node 22 built-ins only, no dependencies.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Results

On the kit's practice set the solver scores **1,000,000 / 1,000,000**
(every instance solved in exactly its push-optimal count P\*):

| instance | boxes | pushes | P\* |
| -------- | ----- | ------ | --- |
| i001 | 3 | 13 | 13 |
| i002 | 4 | 16 | 16 |
| i003 | 8 | 29 | 29 |
| i004 | 12 | 47 | 47 |
| i005 | 16 | 60 | 60 |

The house baseline (plain-astar 1.0.0) scores 200,000 on the same set — it
solves only i001 and leaves the other four unsolved. The solver was also
checked on 16 further sets drawn from the kit's own generator (80 levels):
every instance solved in exactly P\*, each set in under 0.5 s.

## License

MIT — see `LICENSE`. An entry for make.fun's sokoban-solver-01-run-20261121
bounty.
