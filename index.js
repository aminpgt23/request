const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql');
const moment = require('moment'); // Pastikan library moment.js terinstal untuk format waktu

// Koneksi ke database MySQL
const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'itjobs'
});

connection.connect((err) => {
    if (err) {
        console.error('Koneksi ke database gagal:', err);
        return;
    }
    console.log('Terhubung ke database MySQL');
});

// Inisialisasi klien WhatsApp
const client = new Client({
    authStrategy: new LocalAuth()
});

// Objek untuk menyimpan status pengguna
const userStatus = {};

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Scan QR code yang muncul dengan WhatsApp.');
});

client.on('ready', () => {
    console.log('Client siap!');
    // Memulai polling database
    setInterval(() => {
        checkStatusUpdates();
    }, 1000); // Cek setiap 10 detik
});


// Mendapatkan daftar grup dan ID-nya
client.on('ready', () => {
    client.getChats().then(chats => {
        const groupChats = chats.filter(chat => chat.isGroup);
        groupChats.forEach(group => {
            console.log(`Nama Grup: ${group.name}, ID Grup: ${group.id._serialized}`);
        });
    });
});


client.on('message', message => {
    const chatId = message.from;
    const messageParts = message.body.toLowerCase().split(' ');

    if (message.body.toLowerCase().startsWith('close')) {
        const requestId = message.body.split(' ')[1]; // Ambil request_id dari pesan setelah kata "close"

        if (requestId) {
            connection.query('UPDATE request_list SET status = "Close" WHERE request_id = ? AND no_wa = ?', [requestId, chatId], (error, results) => {
                if (error) {
                    console.error('Gagal mengupdate status di database:', error);
                    message.reply('Terjadi kesalahan saat memperbarui status di database.');
                    return;
                }
                if (results.affectedRows > 0) {
                    message.reply(`Permintaan dengan ID ${requestId} telah ditutup.`);
                    console.log(`Status user ${chatId} direset dan data di database dengan request_id ${requestId} diperbarui menjadi "Close".`);
                    delete userStatus[chatId]; // Hapus status pengguna setelah diupdate
                } else {
                    message.reply('Tidak ada permintaan aktif dengan ID tersebut untuk ditutup.');
                }
            });
        } else {
            message.reply('Harap sertakan ID permintaan untuk menutup. Format: close (request_id).');
        }
        return;
    }


     // Logika untuk eksekutor yang merespons dengan "oke <request_id>"
     if (messageParts[0] === 'oke' && messageParts[1]) {
        const requestId = messageParts[1];

        // Cek status pekerjaan saat ini
        connection.query('SELECT request_id, status_pekerjaan FROM request_list WHERE request_id = ? AND eksekutor = (SELECT fullname FROM loggin WHERE no_wa = ?) AND status = "Accepted"', [requestId, chatId], (error, results) => {
            if (error) {
                console.error('Gagal memeriksa status di database untuk eksekutor:', error);
                message.reply('Terjadi kesalahan saat memproses data.');
                return;
            }

            if (results.length > 0) {
                const currentStatus = results[0].status_pekerjaan;

                if (currentStatus.toLowerCase() === 'on progress') {
                    message.reply('Request ID yang Anda respon sudah aktif. Harap input dengan benar!');
                    return;
                }

                // Update status pekerjaan menjadi "on progress" jika belum aktif
                connection.query('UPDATE request_list SET status_pekerjaan = "on progress" WHERE request_id = ?', [requestId], (updateError, updateResults) => {
                    if (updateError) {
                        console.error('Gagal mengupdate status pekerjaan:', updateError);
                        message.reply('Terjadi kesalahan saat memperbarui status pekerjaan.');
                        return;
                    }

                    if (updateResults.affectedRows > 0) {
                        message.reply(`Status pekerjaan untuk request ID ${requestId} telah diperbarui.\n\nHarap konfirmasi kembali jika sudah selesai dengan: done ${requestId}.`);
                        console.log(`Status pekerjaan untuk request ID ${requestId} diperbarui oleh eksekutor ${chatId} menjadi "On Progress".`);
                    } else {
                        message.reply('Gagal memperbarui status pekerjaan. Pastikan data yang relevan tersedia.');
                    }
                });
            } else {
                message.reply('Permintaan yang Anda coba kerjakan tidak ditemukan atau belum di-accept.\n\nHanya eksekutor yang dapat merespon permintaan.');
            }
        });

        return;
    }

    // Logika untuk eksekutor yang merespons dengan "done <request_id>"
    if (messageParts[0] === 'done' && messageParts[1]) {
        const requestId = messageParts[1];

        // Cek status pekerjaan saat ini
        connection.query('SELECT request_id, status_pekerjaan, no_wa FROM request_list WHERE request_id = ? AND eksekutor = (SELECT fullname FROM loggin WHERE no_wa = ?) AND status = "Accepted"', [requestId, chatId], (error, results) => {
            if (error) {
                console.error('Gagal memeriksa status di database untuk eksekutor:', error);
                message.reply('Terjadi kesalahan saat memproses data.');
                return;
            }

            if (results.length > 0) {
                const currentStatus = results[0].status_pekerjaan;
                const waClient = results[0].no_wa; 

                if (currentStatus.toLowerCase() === 'completed') {
                    message.reply('Request ID yang Anda respon sudah selesai. Harap mengisi dengan benar!');
                    return;
                }

                // Update status pekerjaan menjadi "completed" jika belum selesai
                connection.query('UPDATE request_list SET status_pekerjaan = "completed" WHERE request_id = ?', [requestId], (updateError, updateResults) => {
                    if (updateError) {
                        console.error('Gagal mengupdate status pekerjaan:', updateError);
                        message.reply('Terjadi kesalahan saat memperbarui status pekerjaan.');
                        return;
                    }

                    if (updateResults.affectedRows > 0) {
                        message.reply(`Status pekerjaan untuk request ID ${requestId} telah selesai.\nKonfirmasi kembali jika user belum meng-close permintaan.`);
                        console.log(`Status pekerjaan untuk request ID ${requestId} diperbarui oleh eksekutor ${chatId} menjadi "Completed".`);

                        // Kirim notifikasi ke klien yang membuat permintaan
                        const requestDetailsQuery = 'SELECT permintaan FROM request_list WHERE request_id = ?';
                        connection.query(requestDetailsQuery, [requestId], (detailsError, detailsResults) => {
                            if (detailsError) {
                                console.error('Gagal mengambil detail permintaan:', detailsError);
                                return;
                            }

                            if (detailsResults.length > 0) {
                                const requestDetail = detailsResults[0].detail;
                                client.sendMessage(waClient, `Permintaan yang Anda buat dengan detail berikut telah selesai: ${requestDetail}.\nHarap meng-close permintaan dengan segera. Terima kasih.`);
                                console.log(`Notifikasi dikirim ke klien ${waClient} mengenai permintaan ID ${requestId}.`);
                            }
                        });
                    } else {
                        message.reply('Gagal memperbarui status pekerjaan. Pastikan data yang relevan tersedia.');
                    }
                });
            } else {
                message.reply('Permintaan yang Anda coba kerjakan tidak ditemukan atau belum di-accept.\n\nHanya eksekutor yang dapat merespon permintaan.');
            }
        });

        return;
    }




    if (message.body.toLowerCase() === 'request') {
        userStatus[chatId] = 'permintaan_baru';
        console.log(`User ${chatId} status: ${userStatus[chatId]}`); // Debug log
        message.reply('Tulis NIP Anda...');
    } else if (userStatus[chatId] === 'permintaan_baru') {
        const nip = message.body.trim();
        console.log(`User ${chatId} mengirim NIP: ${nip}`); // Debug log

        connection.query('SELECT nip, fullname FROM loggin WHERE nip = ?', [nip], (error, results) => {
            if (error) {
                console.error('Gagal mengambil data:', error);
                message.reply('Terjadi kesalahan saat mengambil data.');
                return;
            }

            if (results.length > 0) {
                const row = results[0];
                userStatus[chatId] = { step: 'isi_data', nip: row.nip, fullname: row.fullname };
                message.reply(`REQUEST FORM\nNIP: ${row.nip}\nFullname: ${row.fullname}\nIsi data di bawah ini dengan benar.\n\ndept: \npermintaan: \nlokasi: \ndevice/nama PC: \nwaktu permintaan: \n\nSalin dan isi template ini untuk melanjutkan.`);
            } else {
                message.reply('NIP tidak terdaftar. Harap menghubungi Tim Barcode.');
                //delete userStatus[chatId];
            }
        });
    } else if (userStatus[chatId] && userStatus[chatId].step === 'isi_data') {
        const inputData = message.body.trim().split('\n');
        const data = {};

        inputData.forEach(line => {
            const [key, value] = line.split(':').map(str => str.trim());
            if (key && value) {
                data[key.toLowerCase()] = value;
            }
        });

        if (data['dept'] && data['permintaan'] && data['lokasi'] && data['device/nama pc'] && data['waktu permintaan']) {
            const requestId = generateUniqueId(); // Fungsi untuk membuat ID permintaan unik
            userStatus[chatId].request_id = requestId;

            const query = `
                INSERT INTO request_list (request_id, nip, fullname, no_wa, dept, permintaan, problem_location, problem_device, waktu_permintaan, date, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Waiting')
            `;
            const values = [
                requestId,
                userStatus[chatId].nip,
                userStatus[chatId].fullname,
                chatId,
                data['dept'],
                data['permintaan'],
                data['lokasi'],
                data['device/nama pc'],
                data['waktu permintaan'],
                moment().format('YYYY-MM-DD HH:mm:ss')
            ];

            connection.query(query, values, (error, results) => {
                if (error) {
                    console.error('Gagal menginsert data:', error);
                    message.reply('Terjadi kesalahan saat menyimpan data.');
                    return;
                }
                message.reply(`Permintaan berhasil disimpan. Harap menunggu persetujuan dalam beberapa menit. Terima kasih.\n\nSalin ini untuk menutup permintaan: close ${requestId}`);
                //message.reply('Permintaan berhasil disimpan. Harap menunggu persetujuan dalam beberapa menit. Terima kasih.');
                console.log(`Permintaan user ${chatId} disimpan dengan request_id ${requestId}.`); // Debug log
            });
        } else {
            message.reply('Data tidak lengkap. Pastikan semua field diisi dengan format yang benar.');
            console.log(`User ${chatId} mengirim data tidak lengkap.`); // Debug log
        }
    }
});



// Fungsi untuk mengecek perubahan status di database
function checkStatusUpdates() {
    Object.keys(userStatus).forEach(chatId => {
        const user = userStatus[chatId];

        if (user.request_id) {
            connection.query('SELECT status, waktu_pengerjaan, eksekutor, problem_location FROM request_list WHERE request_id = ?', [user.request_id], (error, results) => {
                if (error) {
                    console.error('Gagal memeriksa status di database:', error);
                    return;
                }

                if (results.length > 0) {
                    const row = results[0];

                    if (row.status.toLowerCase() === 'accepted') {
                        // Kirim pesan ke user bahwa permintaan di-approve
                        client.sendMessage(chatId, `Permintaan Anda sudah diterima dan akan dikerjakan pada ${row.waktu_pengerjaan} oleh ${row.eksekutor}.\n\nSalin ini untuk menutup permintaan: close ${user.request_id}`);
                        console.log(`User ${chatId} diberitahu bahwa permintaan dengan request_id ${user.request_id} telah di-approve.`);

                        // Cari nomor WA eksekutor di tabel loggin
                        connection.query('SELECT no_wa FROM loggin WHERE fullname = ?', [row.eksekutor], (err, execResults) => {
                            if (err) {
                                console.error('Gagal mencari no_wa eksekutor:', err);
                                return;
                            }

                            if (execResults.length > 0) {
                                const executorNoWa = execResults[0].no_wa;
                                // Kirim pesan ke eksekutor
                                client.sendMessage(executorNoWa, `Permintaan dari user ${chatId} pada ${row.waktu_pengerjaan} di lokasi ${row.problem_location} perlu ditangani. \n\n REQUEST ID : ${user.request_id}`);
                                console.log(`Pesan dikirim ke eksekutor ${row.eksekutor} dengan nomor ${executorNoWa}.`);

                                // Kirim pesan ke grup WhatsApp
                                const groupId = '120363362272874155@g.us'; // Ganti dengan ID grup yang sesuai
                                client.sendMessage(groupId, `Permintaan dari user ${chatId} pada ${row.waktu_pengerjaan} di lokasi ${row.problem_location} akan dikerjakan oleh ${row.eksekutor}. \n\n REQUEST ID : ${user.request_id}`);
                                console.log(`Pesan dikirim ke grup dengan ID ${groupId}.`);
                            } else {
                                console.log(`No WA untuk eksekutor ${row.eksekutor} tidak ditemukan.`);
                            }
                        });

                        // Reset status pengguna setelah notifikasi dikirim
                        delete userStatus[chatId];
                    }
                }
            });
        }
    });
}


// Fungsi untuk membuat ID permintaan unik
function generateUniqueId() {
    return 'REQ-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

client.initialize();
