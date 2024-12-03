import { Component } from '@angular/core';
import { User } from '../user.interface';
import { AuthService } from '../../services/auth.service';
import { ActivatedRoute, Router } from '@angular/router';
import { SharedService } from '../../services/shared.service';

@Component({
  selector: 'app-profile',
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.css'
})
export class ProfileComponent {
  constructor(private route : ActivatedRoute, private auth : AuthService, private router : Router, private sharedService : SharedService){};

  user! :User;

  ngOnInit(){
    const userId = this.route.snapshot.paramMap.get('userId');
      if (userId) {
        // Use shared service to fetch article from API
        this.sharedService.getUser(userId).subscribe((res : any) => {
          this.user = res.data.user;
        });
      }
  }

  logMeOut(){
    this.auth.isLoggedIn = false;
    this.router.navigate(["/"]);
  }


}