# Shared AVN UI package

Analytics uses the local `avn-ui-0.3.2.tgz` build. `avn-ui-0.3.2.patch` holds everything it adds to AVN-Style: the dialog/toast and fixed-picker corrections (0.3.1), and the NutBot panel's header actions, views, embedded mode and app-kept draft plus dialog classes and inner-menu Escape (0.3.2). These changes have not been published to the AVN-Style repository.

To reproduce, check out AVN-Style commit `74b8750e29bf0ce00ab20afae598b336cd01ddda`, apply the patch from that repository's root, run `npm ci && npm run check`, then `cd packages/ui && npm pack`. Copy the resulting tarball here and run `npm install` in `web/`.

The patch preserves the shared default of app-relative popovers. Analytics explicitly opts into `position="fixed"` because its overlays are attached to the browser viewport. Dialog toast actions do not dismiss the task that created them.
