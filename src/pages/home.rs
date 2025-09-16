use leptos::prelude::*;
use crate::components::portfolio::Portfolio;

#[component]
pub fn Home() -> impl IntoView {
    view! {
        <div>
            <Portfolio />
        </div>
    }
}
