// @ts-check
/**
 * The grep-mode retrieval corpus. GENERATED -- do not edit.
 *
 * Regenerate with `python3 tools/build_cards.py` after changing resume.json; CI
 * runs `--check` and fails if this file is stale.
 *
 * One card per retrievable unit: each job bullet, each education bullet, each
 * summary, each hobby, plus one card for the skills list and one per job as a
 * whole. `title` is the context a bullet needs to read as an answer rather than a
 * fragment; `keywords` is the curated relevance signal from resume.json, which
 * fallback.js boosts 3x.
 *
 * @typedef {object} Card
 * @property {string} id
 * @property {'summary'|'job'|'bullet'|'education'|'skills'|'hobby'} kind
 * @property {string} title    Context line, e.g. "Software Engineer, ALICE at CERN".
 * @property {string} [meta]   Dates, location -- shown after the title.
 * @property {string} text     The verbatim resume content.
 * @property {string[]} keywords   Curated in resume.json. Boosted 3x.
 * @property {string[]} [aliases]  Generated search aliases; see EXTRA_KEYWORDS.
 * @property {string} [see]    A command that shows more, e.g. "experience".
 */

/** @type {Card[]} */
export const CARDS = [
  {
    "id": "summary-0",
    "kind": "summary",
    "title": "Summary",
    "text": "Software engineer, postdoctoral fellow, and lecturer with over 7 years of experience in the tech industry and academia, specializing in innovative software development and leadership. Proficient in Python and C++, with a proven track record of leading cross-functional teams and pioneering advanced technological solutions at renowned institutions like UT Austin and CERN. Passionate about technology, physics, and teaching.",
    "keywords": [
      "Software Engineer",
      "Postdoctoral Fellow",
      "Lecturer",
      "Python",
      "C++",
      "Leadership"
    ],
    "see": "summary",
    "aliases": [
      "summary",
      "about",
      "overview",
      "bio",
      "background"
    ]
  },
  {
    "id": "job-0",
    "kind": "job",
    "title": "Principal Software Engineer, VenHub",
    "meta": "Pasadena, CA, 2023-2025",
    "text": "Principal Software Engineer, VenHub (Pasadena, CA, 2023-2025)",
    "keywords": [
      "Principal Software Engineer",
      "VenHub",
      "Pasadena, CA"
    ],
    "see": "experience",
    "aliases": [
      "work",
      "job",
      "role",
      "position",
      "employer",
      "career",
      "experience"
    ]
  },
  {
    "id": "job-0-bullet-0",
    "kind": "bullet",
    "title": "Principal Software Engineer, VenHub",
    "meta": "Pasadena, CA, 2023-2025",
    "text": "Developed early software infrastructure, including microcontroller firmware (C++), hub control servers and application backends (Python/FastAPI), computer vision server (Python/PyTorch/torchvision), and the customer application frontend (TypeScript/React/React Native)",
    "keywords": [
      "C++",
      "Python",
      "FastAPI",
      "PyTorch",
      "Torchvision",
      "TypeScript",
      "React",
      "React Native"
    ],
    "see": "experience"
  },
  {
    "id": "job-0-bullet-1",
    "kind": "bullet",
    "title": "Principal Software Engineer, VenHub",
    "meta": "Pasadena, CA, 2023-2025",
    "text": "Mentored and guided a team of 8+ engineers in developing the company's core technology, constantly exceeding project goals",
    "keywords": [],
    "see": "experience"
  },
  {
    "id": "job-0-bullet-2",
    "kind": "bullet",
    "title": "Principal Software Engineer, VenHub",
    "meta": "Pasadena, CA, 2023-2025",
    "text": "Architected and implemented a multi-threaded robotic control system in Python, decreasing order processing time by over 50% and increasing SKU capacity by 10x",
    "keywords": [
      "Python"
    ],
    "see": "experience"
  },
  {
    "id": "job-0-bullet-3",
    "kind": "bullet",
    "title": "Principal Software Engineer, VenHub",
    "meta": "Pasadena, CA, 2023-2025",
    "text": "Established and enforced version control best practices on GitHub for organizational code management",
    "keywords": [
      "GitHub"
    ],
    "see": "experience"
  },
  {
    "id": "job-0-bullet-4",
    "kind": "bullet",
    "title": "Principal Software Engineer, VenHub",
    "meta": "Pasadena, CA, 2023-2025",
    "text": "Managed stakeholder relationships, including investors and vendors, to ensure technical goals aligned with business objectives",
    "keywords": [],
    "see": "experience"
  },
  {
    "id": "job-1",
    "kind": "job",
    "title": "Lecturer + Postdoctoral Fellow, UT Austin",
    "meta": "Austin, TX, 2023-present",
    "text": "Lecturer + Postdoctoral Fellow, UT Austin (Austin, TX, 2023-present)",
    "keywords": [
      "Lecturer + Postdoctoral Fellow",
      "UT Austin",
      "Austin, TX"
    ],
    "see": "experience",
    "aliases": [
      "work",
      "job",
      "role",
      "position",
      "employer",
      "career",
      "experience"
    ]
  },
  {
    "id": "job-1-bullet-0",
    "kind": "bullet",
    "title": "Lecturer + Postdoctoral Fellow, UT Austin",
    "meta": "Austin, TX, 2023-present",
    "text": "Conducted cutting-edge research on strange and heavy-flavor quark production at the LHC, performing multi-dimensional angular correlation analyses using C++ and Python with execution distributed across supercomputing clusters.",
    "keywords": [
      "C++",
      "Python",
      "LHC",
      "Supercomputing Clusters"
    ],
    "see": "experience"
  },
  {
    "id": "job-1-bullet-1",
    "kind": "bullet",
    "title": "Lecturer + Postdoctoral Fellow, UT Austin",
    "meta": "Austin, TX, 2023-present",
    "text": "Taught full semester of PHY302K, an introductory physics course for STEM majors with over 100 students",
    "keywords": [],
    "see": "experience"
  },
  {
    "id": "job-1-bullet-2",
    "kind": "bullet",
    "title": "Lecturer + Postdoctoral Fellow, UT Austin",
    "meta": "Austin, TX, 2023-present",
    "text": "Mentored multiple graduate and undergraduate students, providing regular guidance on research goals.",
    "keywords": [],
    "see": "experience"
  },
  {
    "id": "job-1-bullet-3",
    "kind": "bullet",
    "title": "Lecturer + Postdoctoral Fellow, UT Austin",
    "meta": "Austin, TX, 2023-present",
    "text": "Authored and published multiple first-author papers in Physical Review C and presented research at key scientific conferences",
    "keywords": [],
    "see": "experience"
  },
  {
    "id": "job-1-bullet-4",
    "kind": "bullet",
    "title": "Lecturer + Postdoctoral Fellow, UT Austin",
    "meta": "Austin, TX, 2023-present",
    "text": "Served on multiple review committees for the ALICE collaboration at CERN",
    "keywords": [
      "CERN"
    ],
    "see": "experience"
  },
  {
    "id": "job-2",
    "kind": "job",
    "title": "Software Engineer, ALICE at CERN",
    "meta": "Meyrin, Switzerland, 2018-2022",
    "text": "Software Engineer, ALICE at CERN (Meyrin, Switzerland, 2018-2022)",
    "keywords": [
      "Software Engineer",
      "ALICE at CERN",
      "Meyrin, Switzerland"
    ],
    "see": "experience",
    "aliases": [
      "work",
      "job",
      "role",
      "position",
      "employer",
      "career",
      "experience"
    ]
  },
  {
    "id": "job-2-bullet-0",
    "kind": "bullet",
    "title": "Software Engineer, ALICE at CERN",
    "meta": "Meyrin, Switzerland, 2018-2022",
    "text": "Developed a C++ software suite to test and characterize hardware components for the ALICE detector upgrade, focusing on picosecond timing resolution and high-throughput data transfers",
    "keywords": [
      "C++"
    ],
    "see": "experience"
  },
  {
    "id": "job-2-bullet-1",
    "kind": "bullet",
    "title": "Software Engineer, ALICE at CERN",
    "meta": "Meyrin, Switzerland, 2018-2022",
    "text": "Conducted initial prototyping in Python and identified regressions using unit tests (unittest)",
    "keywords": [
      "Python",
      "Unit Tests"
    ],
    "see": "experience"
  },
  {
    "id": "job-2-bullet-2",
    "kind": "bullet",
    "title": "Software Engineer, ALICE at CERN",
    "meta": "Meyrin, Switzerland, 2018-2022",
    "text": "Integrated hardware testing into the GitLab pipeline to ensure accuracy and consistency",
    "keywords": [
      "GitLab"
    ],
    "see": "experience"
  },
  {
    "id": "education-0",
    "kind": "education",
    "title": "Doctorate Degree in Particle Physics, University of Texas at Austin",
    "meta": "Austin, TX, 2017-2023",
    "text": "Doctorate Degree in Particle Physics, University of Texas at Austin (Austin, TX, 2017-2023)",
    "keywords": [
      "Doctorate Degree",
      "Particle Physics",
      "University of Texas at Austin"
    ],
    "see": "education",
    "aliases": [
      "school",
      "university",
      "college",
      "education",
      "degree",
      "studied",
      "study"
    ]
  },
  {
    "id": "education-0-bullet-0",
    "kind": "bullet",
    "title": "Doctorate Degree in Particle Physics, University of Texas at Austin",
    "meta": "Austin, TX, 2017-2023",
    "text": "GPA: 4.0",
    "keywords": [],
    "see": "education"
  },
  {
    "id": "education-0-bullet-1",
    "kind": "bullet",
    "title": "Doctorate Degree in Particle Physics, University of Texas at Austin",
    "meta": "Austin, TX, 2017-2023",
    "text": "Recipient of Graduate Provost's Excellence Fellowship, valued over $250,000",
    "keywords": [],
    "see": "education"
  },
  {
    "id": "education-1",
    "kind": "education",
    "title": "Bachelor of Science in Physics and Mathematics, University of Houston",
    "meta": "Houston, TX, 2012-2017",
    "text": "Bachelor of Science in Physics and Mathematics, University of Houston (Houston, TX, 2012-2017)",
    "keywords": [
      "Bachelor of Science",
      "Physics and Mathematics",
      "University of Houston"
    ],
    "see": "education",
    "aliases": [
      "school",
      "university",
      "college",
      "education",
      "degree",
      "studied",
      "study"
    ]
  },
  {
    "id": "education-1-bullet-0",
    "kind": "bullet",
    "title": "Bachelor of Science in Physics and Mathematics, University of Houston",
    "meta": "Houston, TX, 2012-2017",
    "text": "GPA: 3.9",
    "keywords": [],
    "see": "education"
  },
  {
    "id": "education-1-bullet-1",
    "kind": "bullet",
    "title": "Bachelor of Science in Physics and Mathematics, University of Houston",
    "meta": "Houston, TX, 2012-2017",
    "text": "Graduated Magna Cum Laude, ranked #1 in the Physics Department",
    "keywords": [],
    "see": "education"
  },
  {
    "id": "skills",
    "kind": "skills",
    "title": "Skills",
    "text": "expert: Python, Problem Solving, Leadership; experienced: C++, Data Science, Bash, Teaching; skilled: Rust, Machine Learning, C, TypeScript",
    "keywords": [
      "Python",
      "Problem Solving",
      "Leadership",
      "C++",
      "Data Science",
      "Bash",
      "Teaching",
      "Rust",
      "Machine Learning",
      "C",
      "TypeScript"
    ],
    "see": "skills",
    "aliases": [
      "skills",
      "languages",
      "language",
      "programming",
      "technologies",
      "tech",
      "stack",
      "tools"
    ]
  }
];
