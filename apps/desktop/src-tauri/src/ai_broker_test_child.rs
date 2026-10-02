use std::path::Path;
use std::process::Command;

pub fn fixture_command(pid_file: &Path) -> Command {
    fixture_command_for_test("fixture_waits_with_descendant", pid_file)
}

pub fn term_resistant_descendant_fixture_command(pid_file: &Path) -> Command {
    fixture_command_for_test(
        "fixture_parent_exits_with_term_resistant_descendant",
        pid_file,
    )
}

pub fn output_fixture_command(test_name: &str) -> Command {
    let test_binary = std::env::current_exe().expect("locate Rust test binary");
    let mut command = Command::new(test_binary);
    command
        .args([
            "--exact",
            &format!("ai_broker_test_child::{test_name}"),
            "--nocapture",
        ])
        .env("PRV_AI_BROKER_OUTPUT_FIXTURE", "1");
    command
}

pub fn detached_pipe_holding_fixture_command(pid_file: &Path) -> Command {
    fixture_command_for_test("fixture_exits_with_detached_pipe_holder", pid_file)
}

pub fn leader_exits_with_owned_group_descendant_fixture_command(pid_file: &Path) -> Command {
    fixture_command_for_test("fixture_leader_exits_with_owned_group_descendant", pid_file)
}

fn fixture_command_for_test(test_name: &str, pid_file: &Path) -> Command {
    let test_binary = std::env::current_exe().expect("locate Rust test binary");
    let mut command = Command::new(test_binary);
    command
        .args([
            "--exact",
            &format!("ai_broker_test_child::{test_name}"),
            "--nocapture",
        ])
        .env("PRV_AI_BROKER_CHILD_PID_FILE", pid_file);
    command
}

// Every parent waits for this file to appear and then parses it. A plain write creates the file
// empty and fills it afterwards, so the parent can observe an unparseable empty PID. Publishing
// through a temporary name plus `rename` makes the file appear only once it is complete.
fn publish_fixture_descendant_pid(pid_file: &str, pid: u32) {
    let staged = format!("{pid_file}.staged");
    std::fs::write(&staged, pid.to_string()).expect("stage fixture descendant PID");
    std::fs::rename(&staged, pid_file).expect("publish fixture descendant PID");
}

#[cfg(unix)]
#[test]
fn fixture_parent_exits_with_term_resistant_descendant() {
    // Arrange
    let Ok(pid_file) = std::env::var("PRV_AI_BROKER_CHILD_PID_FILE") else {
        return;
    };

    // Act
    let ready_file = format!("{pid_file}.ready");
    let test_binary = std::env::current_exe().expect("locate Rust test binary");
    let descendant = Command::new(test_binary)
        .args([
            "--exact",
            "ai_broker_test_child::fixture_ignores_term",
            "--nocapture",
        ])
        .env("PRV_AI_TERM_RESISTANT_FIXTURE", "1")
        .env("PRV_AI_TERM_RESISTANT_READY_FILE", &ready_file)
        .spawn()
        .expect("start TERM-resistant fixture descendant");
    publish_fixture_descendant_pid(&pid_file, descendant.id());
    let ready_deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while !std::path::Path::new(&ready_file).exists() {
        assert!(
            std::time::Instant::now() < ready_deadline,
            "TERM-resistant fixture descendant did not finish setup"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    println!("fixture-term-resistant-ready");

    // Assert
    assert!(descendant.id() > 0, "fixture descendant has a process ID");
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

#[cfg(unix)]
#[test]
fn fixture_ignores_term() {
    // Arrange
    if std::env::var_os("PRV_AI_TERM_RESISTANT_FIXTURE").is_none() {
        return;
    }

    // Act
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
    let ready_file = std::env::var("PRV_AI_TERM_RESISTANT_READY_FILE")
        .expect("TERM-resistant fixture ready file is configured");
    std::fs::write(ready_file, "ready").expect("record TERM-resistant fixture setup");

    // Assert
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

#[cfg(unix)]
#[test]
fn fixture_emits_oversized_frame() {
    // Arrange
    if std::env::var_os("PRV_AI_BROKER_OUTPUT_FIXTURE").is_none() {
        return;
    }

    // Act
    println!("{}", "x".repeat(512));

    // Assert
}

#[cfg(unix)]
#[test]
fn fixture_emits_truncated_frame() {
    // Arrange
    if std::env::var_os("PRV_AI_BROKER_OUTPUT_FIXTURE").is_none() {
        return;
    }

    // Act
    use std::io::Write;
    std::io::stdout()
        .write_all(br#"{"type":"thread.started"}"#)
        .expect("write an unterminated JSONL frame");

    // Assert
    std::process::exit(0);
}

#[cfg(unix)]
#[test]
fn fixture_emits_decode_failed_frame() {
    // Arrange
    if std::env::var_os("PRV_AI_BROKER_OUTPUT_FIXTURE").is_none() {
        return;
    }

    // Act
    use std::io::Write;
    std::io::stdout()
        .write_all(&[0xff, b'\n'])
        .expect("write non-UTF-8 output");

    // Assert
}

#[cfg(unix)]
#[test]
fn fixture_exits_with_detached_pipe_holder() {
    // Arrange
    let Ok(pid_file) = std::env::var("PRV_AI_BROKER_CHILD_PID_FILE") else {
        return;
    };

    // Act
    use std::os::unix::process::CommandExt;
    let test_binary = std::env::current_exe().expect("locate Rust test binary");
    let mut command = Command::new(test_binary);
    command
        .args([
            "--exact",
            "ai_broker_test_child::fixture_holds_detached_inherited_pipes",
            "--nocapture",
        ])
        .env("PRV_AI_DETACHED_PIPE_FIXTURE", "1");
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let descendant = command
        .spawn()
        .expect("start detached pipe-holding fixture");
    publish_fixture_descendant_pid(&pid_file, descendant.id());
    println!("fixture-detached-pipe-ready");

    // Assert
    assert!(descendant.id() > 0, "fixture descendant has a process ID");
}

#[cfg(unix)]
#[test]
fn fixture_holds_detached_inherited_pipes() {
    // Arrange
    if std::env::var_os("PRV_AI_DETACHED_PIPE_FIXTURE").is_none() {
        return;
    }

    // Act
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }

    // Assert
}

#[cfg(unix)]
#[test]
fn fixture_leader_exits_with_owned_group_descendant() {
    // Arrange
    let Ok(pid_file) = std::env::var("PRV_AI_BROKER_CHILD_PID_FILE") else {
        return;
    };

    // Act
    let descendant = Command::new("sleep")
        .arg("60")
        .spawn()
        .expect("start owned-group descendant");
    publish_fixture_descendant_pid(&pid_file, descendant.id());
    let release_file = format!("{pid_file}.release");
    while !std::path::Path::new(&release_file).exists() {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }

    // Assert
    assert!(descendant.id() > 0, "fixture descendant has a process ID");
    // Return only after the parent test records its birth identity: the descendant retains the
    // broker-created process group after the leader exits, exactly the unresolved recovery state.
}

#[cfg(unix)]
#[test]
fn fixture_waits_with_descendant() {
    // Arrange
    let Ok(pid_file) = std::env::var("PRV_AI_BROKER_CHILD_PID_FILE") else {
        return;
    };

    // Act
    let descendant = Command::new("sleep")
        .arg("60")
        .spawn()
        .expect("start fixture descendant");
    publish_fixture_descendant_pid(&pid_file, descendant.id());
    println!("fixture-ready");

    // Assert
    assert!(descendant.id() > 0, "fixture descendant has a process ID");

    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
