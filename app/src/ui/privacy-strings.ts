// The privacy notice's lines (D25; plan 0029), apart from ui/strings.ts, which holds them with
// every other line under the same keys (`privacy.*`): a notice that lists every field of every
// signal is long enough to need a file of its own. ui/general.ts lays them out.

export const PRIVACY_STRINGS = {
  // The privacy notice beside the reports question, in Setup's Reports step and in General ›
  // Reports while it is unanswered (D25; owner, 2026-10-15: "show the full notice again"). Only
  // what is true of this version: usage counts go to Umami Cloud after a yes; crash reports have
  // nowhere to go yet (D23).
  "privacy.optional":
    "Reports are optional, and saying no changes nothing else: Reload keeps restarting its processes and updating its packages either way.", // decided
  "privacy.sent": "What is sent", // decided
  "privacy.sent.where":
    "If you say yes, usage events are sent to Umami Cloud, the analytics service that processes them, each time one of the things below happens. Each one carries the first three, and what happened:", // plan 0029
  "privacy.sent.machineId":
    "a machine id: a keyed hash (HMAC-SHA256) of your computer's own identifier, the same every time. The identifier itself never leaves this computer", // decided
  "privacy.sent.versions":
    "the Reload version, your operating system, its version and the processor type", // decided
  "privacy.sent.stamp":
    "what kind of report it is and which of the things below happened, when it was made, a random number that tells it apart, and the version of the rules it was checked by", // plan 0029
  "privacy.sent.launches":
    "when Reload starts and quits: how long it took to start, how many packages are installed and how many of them are unsigned, then each installed package on its own (the package and its version if it ships with Reload or is signed, an unsigned one only as unsigned; where it came from, whether it is signed, what it runs on), how long Reload ran, why it quit, whether it is its first start, and the version that last ran when it ended without quitting", // plan 0029
  "privacy.sent.steps":
    "every time a step of a package runs, or a package's source starts a run: the package, its version, where it came from, whether it is signed, what it runs on, the kind and type of the step but never its name, how long it took and whether it worked. A package nobody signed is only called unsigned, with neither its version nor its type of step", // plan 0029
  "privacy.sent.errors":
    "every time such a step, or a package's source, fails: the same, the kind of error when it is a standard one (any other is only other), and the file and line in the package where it happened, only when the file is one of the signed package's own and the line is in it. Never the error's message", // plan 0029
  "privacy.sent.aiApps":
    "every time an AI app uses Reload's Anytype tools or reads a file through them: the Anytype package and its version, whether it called a tool or read a file, which of Reload's own Anytype tools, which known AI app it is (any other is only other), how long it took, whether it worked and the error's code, never what it asked, which file, or what it was answered", // plan 0029
  "privacy.sent.flows":
    "every time flows are deployed: how many flows and steps in all, how many steps each flow has with the steps inside its subflows, how many configuration nodes there are, and how many steps of each package", // plan 0029
  "privacy.sent.setup":
    "which first steps you reached: Reload started, Anytype paired, a first flow deployed", // plan 0029
  "privacy.sent.catalogues":
    "when a package catalogue is added or removed: its server's name only if it is Reload's own (a local one is only file, any other only custom), whether it is Reload's own, a short fingerprint of its signing key and how many packages it offers", // plan 0029
  "privacy.sent.installs":
    "when a package is installed, updated, removed or refused: the package and its versions if it is signed (an unsigned one only as unsigned), Reload's own catalogue's server name, or only that it came from another catalogue or a file, whether it is signed, what it runs on, how many step types it brings, and the reason's code, never its words", // plan 0029
  "privacy.sent.updates":
    "when a newer Reload is offered or installed: the versions and the update channel", // plan 0029
  "privacy.sent.address":
    "Like any request over the internet, each one also gives Umami Cloud your IP address, from which Umami works out your country, region and city.", // decided
  "privacy.sent.wrapped":
    "Sending puts each one in the form Umami Cloud takes, adding only the Reload version and values that are the same on every computer.", // decided
  "privacy.sent.crashes": "Crash reports aren't sent: this version has nowhere to send them.", // decided
  "privacy.never": "What is never sent", // decided
  "privacy.never.line":
    "Your Anytype key or any other key, token or password. Any error's message. Anything from your Anytype content, or the names of your objects, spaces, flows or steps. Anything you set a step up with, what passes through a flow, what an AI app asks or is answered, the contents of any file, audio or transcript, the values of environment variables, full paths inside your home folder, a catalogue's full address, your user name, your computer's name, or its raw identifier.", // plan 0029
  "privacy.kept": "How long it is kept", // decided
  "privacy.kept.line": "Umami Cloud keeps usage counts for 6 months, then deletes them.", // decided
  "privacy.rights": "Your rights under the GDPR", // decided
  "privacy.rights.pseudonymous":
    "The machine id carries no name, but under the GDPR it is still pseudonymous personal data.", // decided
  "privacy.rights.contact":
    "Under the GDPR you can ask about your data and ask for it to be deleted. Write to Re:Circuit Cooperative, who make Reload, at privacy@recircu.it.", // decided
  "privacy.rights.line":
    "Usage counts carry no name, email or account, only the machine id, so Reload holds nothing to look anyone up by.", // decided
  "privacy.rights.see":
    "See what would be sent, in Configuration › General, shows what each report carries before it is sent.", // decided
  "privacy.rights.change":
    "Nothing is sent until you answer. You can change your answer at any time in Configuration › General › Reports: turning reports off stops all sending at once and deletes anything still waiting.", // decided
} as const;
