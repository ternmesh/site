# Contributing to ternmesh/site

Thank you for helping. This repository is one part of Tern; how the
project is governed, and who decides what, is in
[GOVERNANCE.md](https://github.com/ternmesh/spec/blob/main/GOVERNANCE.md)
in the specification repository.

## Sign your commits (DCO)

Tern uses the [Developer Certificate of Origin](DCO) instead of a
contributor licence agreement. You keep the rights to your work; you
certify that you are allowed to contribute it under this repository's
licence.

Add a `Signed-off-by` line to every commit with your real name and an
email address you control:

```bash
git commit -s -m "Describe the change"
```

Pull requests with unsigned commits cannot be merged. To sign commits
you have already made: `git rebase --signoff main`.

## Licence

Contributions are licensed under the [Apache License 2.0](LICENSE).

## The site describes; the specification defines

Nothing on this site is normative. A page that says how the protocol
behaves must agree with [ternmesh/spec](https://github.com/ternmesh/spec);
if they disagree, the site is wrong. A change to how the protocol works
is a specification change, made there first.
