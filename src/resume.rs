use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactInfo {
    pub name: String,
    pub phone: String,
    pub email: String,
    pub github: String,
    pub linkedin: String,
    pub website: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub text: String,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bullet {
    pub text: String,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Education {
    pub institution: String,
    pub location: String,
    pub degree: String,
    #[serde(rename = "fieldOfStudy")]
    pub field_of_study: String,
    #[serde(rename = "startDate")]
    pub start_date: String,
    #[serde(rename = "endDate")]
    pub end_date: String,
    pub bullets: Vec<Bullet>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub title: String,
    pub company: String,
    pub location: String,
    #[serde(rename = "startDate")]
    pub start_date: String,
    #[serde(rename = "endDate")]
    pub end_date: String,
    pub bullets: Vec<Bullet>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub experience: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resume {
    #[serde(rename = "contactInfo")]
    pub contact_info: ContactInfo,
    pub summaries: Vec<Summary>,
    pub educations: Vec<Education>,
    pub jobs: Vec<Job>,
    pub projects: Vec<serde_json::Value>, // Can add specific type later if needed
    pub skills: Vec<Skill>,
}

impl Resume {
    pub fn load() -> Result<Self, String> {
        let resume_json = include_str!("../resume.json");
        serde_json::from_str(resume_json)
            .map_err(|e| format!("Failed to parse resume.json: {}", e))
    }
}
