# ui-component-builder

## Trigger

Use this skill for anything a user can see, including components, screens, styling, UI states, design-system changes, responsive behavior, and visual indicators.

## Purpose

Keep Fixora UI consistent, accessible, semantic, and faithful to the product rules.

## Semantic-token discipline

Use semantic design tokens rather than hard-coded presentation values.

Do not scatter raw colors, spacing, typography, or state values through components when an existing semantic token represents the concept.

Prefer concepts such as:

- foreground;
- background;
- surface;
- border;
- muted;
- success;
- warning;
- destructive;
- focus;
- interactive.

Use the repository's existing token names where they exist.

## Missing-token gap filling

If a required semantic token does not exist:

1. identify the semantic purpose;
2. inspect neighboring design-system usage;
3. add the smallest appropriate token;
4. use that token in the component;
5. avoid introducing one-off raw values.

Do not create duplicate tokens with overlapping meanings.

## Visible state flags

Important states must not be communicated by color alone.

For example, auto-completed orders must be visibly distinguishable from manually confirmed completions using an explicit label, icon, text, or other non-color cue.

Featured providers/subscriptions should use an explicit visible indicator rather than relying only on styling.

## 360px accessibility floor

UI must remain usable at a 360px viewport width.

Check:

- no accidental horizontal overflow;
- readable text;
- usable controls;
- tap targets;
- labels and state indicators;
- responsive layout behavior.

Do not solve narrow layouts by hiding required product information.

## Fixora-specific rules

- Role is a UI default, not a hard capability wall.
- Providers may also act as customers.
- Self-order restrictions are business rules, not a reason to hide unrelated customer functionality.
- Starting price and agreed price are informational values, not payment UI.
- Do not imply job payment exists in v1.
- Provider phone numbers must not appear to customers without the permitted order relationship.
- Auto-completed orders must be visibly distinguished.

## Completion checklist

- [ ] Existing semantic tokens reused.
- [ ] New token added only when necessary.
- [ ] No unnecessary raw presentation values.
- [ ] Important state is not color-only.
- [ ] Auto-completion is visibly distinguished.
- [ ] Featured state is explicit.
- [ ] No UI implies unavailable v2/v3 payment functionality.
- [ ] Ownership/privacy rules are reflected in visible data.
- [ ] UI works at 360px.
- [ ] Focus/interaction states remain usable.
- [ ] Relevant component/screen tests pass.