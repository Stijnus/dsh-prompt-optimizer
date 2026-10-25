# Releasing

Releases are tag-driven. Pushing a `vX.Y.Z` tag runs
`.github/workflows/release.yml`, which:

1. checks that the tag matches `package.json` `version`,
2. installs and runs the tests,
3. skips publishing when that version already exists on the registry,
4. publishes with `npm publish --provenance --access public`,
5. waits until the registry exposes the new version.

The workflow authenticates with npm **trusted publishing** (OIDC), so no
`NPM_TOKEN` secret is stored in GitHub.

## One-time setup: trusted publishing

npm must be told which repository and workflow may publish this package.

1. Create the `@stijnus` npm scope (if it does not exist) and make sure the
   account owns it.
2. Open <https://www.npmjs.com/package/dsh-prompt-rewrite> →
   **Settings**.
3. Under **Trusted publishing**, add a **GitHub Actions** publisher:
   - Organization or user: `Stijnus`
   - Repository: `dsh-prompt-optimizer`
   - Workflow filename: `release.yml`
   - Environment: leave empty
   - Allowed actions: enable direct `npm publish`
4. Save. Complete the first successful publication within two days, before a
   new publisher configuration expires.

Until this exists, a tag for an unpublished version fails at the publish step
with an authentication error.

## Cutting a release

```sh
# 1. Land the change on main with tests green.
npm test

# 2. Bump the version and update CHANGELOG.md.
npm version minor --no-git-tag-version   # or patch / major
#    edit CHANGELOG.md: move "Unreleased" entries under the new version

# 3. Commit and tag.
git add -A
git commit -m "chore(release): v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"

# 4. Push the commit and the tag; CI publishes.
git push origin main --follow-tags
```

`npm version` is intentionally run with `--no-git-tag-version` so the version
bump is committed together with the changelog before the tag is created.

## After publishing

- Confirm the npm page shows the new version with a provenance attestation.
- If the plugin market index needs the new version, update the index entry that
  points at this repository.
- Announce in the DSH discussions thread if relevant.

## Local profile install (development)

`install_bundle` links a local checkout, so the profile does not install this
package's dependencies. Run `npm install` in the checkout first; see the README.
