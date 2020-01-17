// This import loads the firebase namespace along with all its type information.
import firebase from 'firebase/app';
import 'firebase/auth';

// patched firestore for enablePersistence
// See https://github.com/firebase/firebase-js-sdk/issues/983
import { registerFirestore } from './external/patched-firestore';

export function getUid(): string {
	return firebase.auth().currentUser?.uid as string;
}

let _db: firebase.firestore.Firestore;
export function getDB(): firebase.firestore.Firestore {
	return _db;
}

export async function initFirebase() {
	registerFirestore(firebase as any);
	firebase.initializeApp({
		projectId: 'mizchi-vscode',
		databaseURL: 'https://mizchi-vscode.firebaseio.com',
		storageBucket: 'mizchi-vscode.appspot.com',
		locationId: 'asia-northeast1',
		apiKey: 'AIzaSyA1z6FzFRnVAvDx4zyl9pmtDVEG8VXHZsw',
		authDomain: 'mizchi-vscode.firebaseapp.com',
		messagingSenderId: '987311356176'
	});

	// enable offline first
	try {
		_db = firebase.firestore();
		await _db.enablePersistence({ experimentalForce: true } as any);
	} catch (err) {
		console.log('Start without persitence', err);
	}

	// auth
	try {
		const user = await firebase.auth().signInAnonymously();
		console.log(user);
	} catch (error) {
		console.error('login failed', error);
	}
}
