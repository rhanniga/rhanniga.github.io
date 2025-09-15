use leptos::prelude::*;
use leptos_meta::*;
use leptos_router::{components::*, path};

// Modules
mod components;
mod pages;
mod resume;

// Top-Level pages
use crate::pages::home::Home;

/// An app router which renders the homepage and handles 404's
#[component]
pub fn App() -> impl IntoView {
    // Provides context that manages stylesheets, titles, meta tags, etc.
    provide_meta_context();

    view! {
        <Html attr:lang="en" attr:dir="ltr" attr:data-theme="dark" />

        // sets the document title
        <Title text="Ryan Hannigan - Portfolio" />

        // injects metadata in the <head> of the page
        <Meta charset="UTF-8" />
        <Meta name="viewport" content="width=device-width, initial-scale=1.0" />
        
        // Add custom styles
        <Style>{include_str!("../styles.css")}</Style>

        <Router>
            <Routes fallback=|| view! { 
                <div class="portfolio">
                    <h1>"Page Not Found"</h1>
                    <p>"The page you're looking for doesn't exist."</p>
                </div>
            }>
                <Route path=path!("/") view=Home />
            </Routes>
        </Router>
    }
}
