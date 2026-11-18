# Creature Rumble

A family TV game. Everyone makes a creature on their phone, and the TV turns them into upright cartoon fighters that drop
into a side-view platform fight on a themed level (a jungle, a space ship, a toy room) and bonk each other off it, with
presents from the sky and a little mischief from the level, until the last one standing is crowned champion. An
announcer calls the fight out loud, and every line is also shown on screen.

## Setup

You need Node 24 or newer.

```sh
npm install
```

Create a `.env` file (see `.env.example`) with your Anthropic API key. It is what lets the designer turn a phone's drawing
or description into a fighter:

```
ANTHROPIC_API_KEY=your-key-here
```

## Running it

- `npm run dev` starts the game for development: the TV page at `http://localhost:5200/` with hot reload, plus the API.
- `npm run home` builds the game and serves it, with the API, on port 8797. Use it for an evening in the living room.
  Open `http://localhost:8797/` in the browser on the PC that is plugged into the TV. The address phones should use is
  printed when it starts.

Run one or the other, not both: they share the API port.

## Joining with phones

Phones need to be on the same Wi-Fi as the PC. Open the phone page printed by `npm run home`, or scan the QR code the TV
shows, or open the page and type the short join code. Pick a name, make a creature, and send it to the TV.

On the phone, hold the **Crown** button for two seconds to crown the champion (a quick tap is not enough, so nobody
crowns by accident).

## TV controls

Use a TV remote, a keyboard or a game controller.

- **Enter** or the remote's **Menu** key opens the menu (**Select** on a controller nobody is playing with). **Back** or
  **Esc** closes it.
- The menu has: **Crown the champion!** and **Again!** (they appear when they can be used), **Fighters** (send a past
  fighter back in), **Level** (Jungle, Space Ship or Toy Room), **Show join code**, **Sound** (quieter, louder, on/off),
  **Clear the stage** and **Back to the fight**.
- The arrow keys (or the d-pad) move around the menu, and Enter presses a button.
- **J** shows or hides the join code (the TV remembers which).

## Playing with a controller

Plug in a game controller (up to four) and steer a creature yourself; everyone else is played by the computer.

- Press **A** or **Start** to pick a creature. Move along the row and press **A** to choose (**B** goes back).
- **A** jump, **X** attack, **Y** special, **B** grab, **RB** use a power-up, **LB** or **RT** dodge. Move with the
  stick or the d-pad.
- Hold **Start** and **Select** together to stop playing (the computer takes the creature back).
- Put the controller down for 20 seconds and the creature rests: the computer plays it until you touch the controller
  again.
- If your creature is knocked out, wait a moment and press **A** or **Start** to pick again.
- **Select** (or the remote's Menu key, or Enter) opens the TV menu, where you crown the champion. Pressing A never
  opens it, so nobody crowns by accident.
- **J** on the keyboard shows or hides the join code.

## Tests

```sh
npm test            # unit tests
npm run balance     # plays many fights to check that no kind of fighter dominates
npm run build       # type-check and production build
```

## Credits

See [CREDITS.md](CREDITS.md).
