mod client;
mod ui;

use adw::prelude::*;

const APP_ID: &str = "io.nrsil.Quire";

fn main() -> gtk::glib::ExitCode {
    let app = adw::Application::builder().application_id(APP_ID).build();
    app.connect_activate(ui::build);
    app.run()
}
