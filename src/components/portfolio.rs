use leptos::prelude::*;
use crate::resume::{Resume, Job, Education, Skill};

#[component]
pub fn Portfolio() -> impl IntoView {
    let resume = Resume::load().unwrap_or_else(|e| {
        log::error!("Failed to load resume: {}", e);
        panic!("Could not load resume data");
    });

    view! {
        <div class="portfolio">
            <Header contact_info=resume.contact_info.clone() />
            <Summary summaries=resume.summaries.clone() />
            <Experience jobs=resume.jobs.clone() />
            <Education educations=resume.educations.clone() />
            <Skills skills=resume.skills.clone() />
        </div>
    }
}

#[component]
fn Header(contact_info: crate::resume::ContactInfo) -> impl IntoView {
    view! {
        <header class="header">
            <h1 class="name">{contact_info.name.clone()}</h1>
            <div class="contact">
                <p>
                    <a href=format!("mailto:{}", contact_info.email.clone())>{contact_info.email.clone()}</a>
                    " | "
                    <a href=format!("tel:{}", contact_info.phone.clone())>{contact_info.phone.clone()}</a>
                </p>
                <p>
                    <a href=format!("https://github.com/{}", contact_info.github.clone()) target="_blank">
                        "GitHub: " {contact_info.github.clone()}
                    </a>
                    " | "
                    <a href=format!("https://linkedin.com/in/{}", contact_info.linkedin.clone()) target="_blank">
                        "LinkedIn: " {contact_info.linkedin.clone()}
                    </a>
                </p>
                <p>
                    <a href=format!("https://{}", contact_info.website.clone()) target="_blank">
                        {contact_info.website.clone()}
                    </a>
                </p>
            </div>
        </header>
    }
}

#[component]
fn Summary(summaries: Vec<crate::resume::Summary>) -> impl IntoView {
    view! {
        <section class="summary">
            <h2>"Summary"</h2>
            {summaries.into_iter().map(|summary| view! {
                <p>{summary.text}</p>
            }).collect::<Vec<_>>()}
        </section>
    }
}

#[component]
fn Experience(jobs: Vec<Job>) -> impl IntoView {
    view! {
        <section class="experience">
            <h2>"Experience"</h2>
            {jobs.into_iter().map(|job| view! {
                <div class="job">
                    <div class="job-header">
                        <h3>{job.title}</h3>
                        <span class="company">{job.company}</span>
                        <span class="location">{job.location}</span>
                        <span class="dates">{format_date_range(&job.start_date, &job.end_date)}</span>
                    </div>
                    <ul class="bullets">
                        {job.bullets.into_iter().map(|bullet| view! {
                            <li>{bullet.text}</li>
                        }).collect::<Vec<_>>()}
                    </ul>
                </div>
            }).collect::<Vec<_>>()}
        </section>
    }
}

#[component]
fn Education(educations: Vec<Education>) -> impl IntoView {
    view! {
        <section class="education">
            <h2>"Education"</h2>
            {educations.into_iter().map(|edu| view! {
                <div class="education-item">
                    <div class="education-header">
                        <h3>{edu.degree}</h3>
                        <span class="field">{edu.field_of_study}</span>
                        <span class="institution">{edu.institution}</span>
                        <span class="location">{edu.location}</span>
                        <span class="dates">{format_date_range(&edu.start_date, &edu.end_date)}</span>
                    </div>
                    <ul class="bullets">
                        {edu.bullets.into_iter().map(|bullet| view! {
                            <li>{bullet.text}</li>
                        }).collect::<Vec<_>>()}
                    </ul>
                </div>
            }).collect::<Vec<_>>()}
        </section>
    }
}

#[component]
fn Skills(skills: Vec<Skill>) -> impl IntoView {
    let expert_skills: Vec<_> = skills.iter().filter(|s| s.experience == "expert").cloned().collect();
    let experienced_skills: Vec<_> = skills.iter().filter(|s| s.experience == "experienced").cloned().collect();
    let skilled_skills: Vec<_> = skills.iter().filter(|s| s.experience == "skilled").cloned().collect();

    view! {
        <section class="skills">
            <h2>"Skills"</h2>
            
            {if !expert_skills.is_empty() {
                view! {
                    <div class="skill-group">
                        <h3>"Expert"</h3>
                        <div class="skill-list">
                            {expert_skills.into_iter().map(|skill| view! {
                                <span class="skill-tag">{skill.name}</span>
                            }).collect::<Vec<_>>()}
                        </div>
                    </div>
                }.into_any()
            } else {
                view! {}.into_any()
            }}
            
            {if !experienced_skills.is_empty() {
                view! {
                    <div class="skill-group">
                        <h3>"Experienced"</h3>
                        <div class="skill-list">
                            {experienced_skills.into_iter().map(|skill| view! {
                                <span class="skill-tag">{skill.name}</span>
                            }).collect::<Vec<_>>()}
                        </div>
                    </div>
                }.into_any()
            } else {
                view! {}.into_any()
            }}
            
            {if !skilled_skills.is_empty() {
                view! {
                    <div class="skill-group">
                        <h3>"Skilled"</h3>
                        <div class="skill-list">
                            {skilled_skills.into_iter().map(|skill| view! {
                                <span class="skill-tag">{skill.name}</span>
                            }).collect::<Vec<_>>()}
                        </div>
                    </div>
                }.into_any()
            } else {
                view! {}.into_any()
            }}
        </section>
    }
}

fn format_date_range(start: &str, end: &str) -> String {
    let format_date = |date_str: &str| -> String {
        if date_str == "Present" {
            "Present".to_string()
        } else {
            // Parse date string like "2023-01-01" and format as "Jan 2023"
            let parts: Vec<&str> = date_str.split('-').collect();
            if parts.len() == 3 {
                let year = parts[0];
                let month = match parts[1] {
                    "01" => "Jan",
                    "02" => "Feb", 
                    "03" => "Mar",
                    "04" => "Apr",
                    "05" => "May",
                    "06" => "Jun",
                    "07" => "Jul",
                    "08" => "Aug",
                    "09" => "Sep",
                    "10" => "Oct",
                    "11" => "Nov",
                    "12" => "Dec",
                    _ => parts[1],
                };
                format!("{} {}", month, year)
            } else {
                date_str.to_string()
            }
        }
    };

    format!("{} - {}", format_date(start), format_date(end))
}
