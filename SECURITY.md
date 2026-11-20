# Security

## Reporting a problem

Please report it privately first: Help › Contact the Author in Konium Designer, or the form at
https://konium.app/support/#contact, with the topic "A security problem, reported privately".
The message goes to the author only. Say what you found, where (a file, a service, an address),
and how to see it happen. You will be answered, and told when it is fixed; say if you would like
to be named in the release note.

Please do not open a public issue for something that could be used against other people's
designs or against the services before it is fixed.

## What counts

- A file that, when opened, runs code, reaches the network, or reads or changes anything other
  than itself (Konium Designer opens files from strangers: every reader treats its input as
  hostile).
- A script (Tools › Scripts) that gets out of its sandbox: a script may read the board it is run
  on and ask for changes to it, and nothing else.
- Anything that makes the program connect when network activity is off, or that sends something
  the list of connections (Help › About) does not say.
- The services behind konium.app (`cloudflare/`): anything that lets one visitor spend the
  service's allowance or storage beyond the limits each README states, write where they should
  not, read what is another's, or have konium.app serve a stranger's content as its own.

## What is already known

docs/REVIEW-26.200.md is the record of the review made before the source went public: what was
found, and the test that shows each finding closed.

## Supported versions

The current release only. Konium Designer has no long-term branches: a fix goes into the next
build, and konium.app serves the newest.
