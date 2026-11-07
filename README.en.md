# dsh-follow-until-screen · Smart Scroll Assistant

Scroll a long reply until it fills exactly one screen, then stop, leaving the first line at the top so you can read the rest at your own pace.

[中文](README.md) | English

## What this project does

DSH follows the bottom by default: when a long reply appears, the page keeps scrolling down, so the moment you finish reading the first sentence it has already slid away. Turning auto-scroll off instead means short replies can no longer appear right away.

This plugin takes a **middle path**:

- **While a reply does not fill one screen**: it keeps following as usual, so new content is always visible;
- **Once a reply fills exactly one screen**: the page stops scrolling, and the beginning stays near the top of the screen;
- **After the turn ends**: the page no longer jumps back to the bottom, so you can read in peace.

It depends on no other plugin. **It scrolls when it should, and stops when it should.**

## Quick start

### Installation

1. Open the **Plugins** page in DSH and click **Add plugin**;
2. Enter the plugin address and confirm:

   ```text
   git+https://github.com/BitStandByYou/dsh-follow-until-screen.git#v0.2.0
   ```

3. After enabling the plugin, you **must refresh the Web UI** (or restart DSH) to load the client script.
