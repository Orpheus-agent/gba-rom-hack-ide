# Modernize bundle - attribution

The "Modernize" feature in this editor applies a patch that you build
locally from **Complete Fire Red Upgrade** by Skeli789 et al.

- **Project**: Complete Fire Red Upgrade (CFRU)
- **Author**: Skeli789 with contributions from the ROM-hacking community
- **Upstream**: https://github.com/Skeli789/Complete-Fire-Red-Upgrade
- **License terms** (quoted verbatim from the upstream README, line 4):

> By using this or any assets from this repository, you consent to never
> making money off your game (unless you have my explicit permission).
> That includes both pay-walls **as well as optional donations** (which
> includes ko-fi, Patreon, etc.).

In plain English: hacks built on top of CFRU - including any hack the
editor produces - are non-commercial. Don't sell them, don't accept
donations for them, don't put them behind a paywall. The upstream
`CFRU Documentation.pdf` carries the full terms.

**No patch binary ships in this repository.** `cfru.bps` / `dpe.bps` are
not distributed here, and `cfru.json` / `dpe.json` are placeholders with
`"built": false`, so the Modernize feature refuses to run until you build
the bundle yourself.

When you build it (`node scripts/build-cfru-bundle.mjs`, or
`build-cfru-bundle-with-dpe.mjs` for the DPE variant) against your own
CFRU clone and your own legally-obtained Pokémon FireRed (USA, version
1.0) ROM, the resulting `cfru.bps` is a binary delta against that ROM. It
carries only Skeli789's contributions, none of Nintendo's copyrighted
bytes, and applying it still requires the user to supply their own
legally-obtained FireRed ROM.
